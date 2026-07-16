import puppeteer from 'puppeteer';
import { query } from '../db/index.js';
import { enrichLeadWithApollo } from './ai.js';

const aggregatorKeywords = [
  "doctify", "top", "best", "find", "directory", "list", "booking", "healthgrades", 
  "trustpilot", "clutch.co", "yelp", "yellowpages", "visitlondon", "tripadvisor",
  "expedia", "agoda", "kayak", "trivago", "timeout", "hotels.com", "intelligentliving"
];

const isAggregator = (lead) => {
  const url = lead.website?.toLowerCase() || "";
  const name = lead.business_name?.toLowerCase() || "";
  
  const isMatch = aggregatorKeywords.some(keyword => 
    url.includes(keyword) || name.includes(keyword)
  );

  const hasAggregatorPatterns = (
    url.includes("/find/") || 
    url.includes("/top-") || 
    url.includes("/best-") || 
    url.includes("/guide") ||
    url.includes("/list-of") ||
    url.includes("/search/") ||
    url.includes("/top/")
  );

  return isMatch || hasAggregatorPatterns;
};

const isRealBusiness = (lead) => {
  if (!lead.website) return false;
  const url = lead.website.toLowerCase();
  if (url.includes("/find/") || url.includes("/top/") || url.includes("/best-")) {
    return false;
  }
  return true;
};

const findEmailAndPhoneWithoutWebsite = async (page, businessName, location) => {
  let email = null;
  let phone = null;

  // Try 1: Search for Gmail specifically
  try {
    const gmailSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(`"${businessName}" "${location}" gmail.com email contact`)}`;
    await page.goto(gmailSearchUrl, { waitUntil: 'networkidle2', timeout: 15000 });

    const gmailResult = await page.evaluate(() => {
      const html = document.body.innerText;
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
      const foundEmails = html.match(emailRegex) || [];
      
      const validEmails = foundEmails.filter(e => {
        const isJunk = e.includes('google.com') || e.includes('schema.org') || e.includes('w3.org') || e.includes('example.com') || e.includes('blogger.com');
        return !isJunk && e.length < 50;
      });

      return validEmails.find(e => e.includes('gmail.com')) || validEmails[0] || null;
    });

    if (gmailResult) email = gmailResult;
  } catch (err) {
    console.log(`⚠️ Gmail search failed for ${businessName}: ${err.message}`);
  }

  // Try 2: Search for phone number
  if (!phone) {
    try {
      const phoneSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(`"${businessName}" "${location}" phone number contact`)}`;
      await page.goto(phoneSearchUrl, { waitUntil: 'networkidle2', timeout: 15000 });

      const phoneResult = await page.evaluate(() => {
        const html = document.body.innerText;
        const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{3,5}/g;
        const phones = (html.match(phoneRegex) || []).filter(p => {
          const digits = p.replace(/[^0-9]/g, '');
          if (digits.length < 7 || digits.length > 15) return false;
          const separatorCount = (p.match(/[-.\s()]/g) || []).length;
          return separatorCount >= 2 || p.startsWith('+') || p.includes('(');
        });
        const uniquePhones = [...new Set(phones)];
        return uniquePhones[0] || null;
      });

      if (phoneResult) phone = phoneResult;
    } catch (err) {
      console.log(`⚠️ Phone search failed for ${businessName}: ${err.message}`);
    }
  }

  return { email, phone };
};

const analyzeWebsitePotential = async (page, url) => {
  if (!url) return { hasWebsite: false, bookingSystem: false, seoScore: 0, mobileFriendly: true, issues: ["No website (High Value Lead 🔥)"], email: null, phone: null };

  try {
    // Add a short delay to ensure site is ready
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const analysis = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const htmlLower = html.toLowerCase();
      
      // 1. Email Extraction
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
      const foundEmails = html.match(emailRegex) || [];
      
      // Find mailto links
      const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'))
        .map(a => a.href.replace('mailto:', '').split('?')[0]);
      
      const allEmails = [...new Set([...foundEmails, ...mailtoLinks])];
      
      // Filter out junk
      const validEmails = allEmails.filter(e => {
        const isImage = /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e);
        const isTooLong = e.length > 50;
        const isInternal = e.includes('wixpress.com') || e.includes('sentry.io') || e.includes('example.com');
        return !isImage && !isTooLong && !isInternal;
      });

      const email = validEmails.find(e => e.includes('gmail.com')) || validEmails[0] || null;

      // 1b. Phone Number Extraction
      const telLinks = Array.from(document.querySelectorAll('a[href^="tel:"]'))
        .map(a => a.href.replace('tel:', '').split('?')[0].trim());
      const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
      const foundPhones = (html.match(phoneRegex) || []).filter(p => {
        const digits = p.replace(/[^0-9]/g, '');
        if (digits.length < 7 || digits.length > 15) return false;
        const separatorCount = (p.match(/[-.\s()]/g) || []).length;
        return separatorCount >= 2 || p.startsWith('+') || p.includes('(');
      });
      const allPhones = [...new Set([...foundPhones, ...telLinks])];
      const phone = allPhones[0] || null;

      // Find potential contact page links
      const links = Array.from(document.querySelectorAll('a[href]'));
      const contactLink = links.find(a => {
        const text = a.innerText.toLowerCase();
        const href = a.href.toLowerCase();
        return text.includes('contact') || text.includes('about') || href.includes('contact');
      })?.href || null;

      // 2. Check for booking systems
      const bookingKeywords = [
        'book now', 'booking', 'appointment', 'schedule', 'calendly', 'acuity', 
        'zocdoc', 'patient portal', 'reservation', 'check availability'
      ];
      const hasBookingSystem = bookingKeywords.some(kw => htmlLower.includes(kw));

      // 3. Check for SEO indicators
      let seoScore = 100;
      const issues = [];
      
      if (!document.querySelector('title')) {
        seoScore -= 20;
        issues.push("Missing meta title");
      }
      if (!document.querySelector('meta[name="description"]')) {
        seoScore -= 20;
        issues.push("Missing meta description");
      }
      if (!document.querySelector('h1')) {
        seoScore -= 20;
        issues.push("No H1 header");
      }

      // Check for Mobile Friendly
      const hasViewport = !!document.querySelector('meta[name="viewport"]');
      if (!hasViewport) {
        issues.push("Not mobile optimized");
      }

      if (!hasBookingSystem) {
        issues.push("No online booking system");
      }

      return {
        hasWebsite: true,
        bookingSystem: hasBookingSystem,
        seoScore: Math.max(seoScore, 20),
        mobileFriendly: hasViewport,
        issues,
        email: email,
        phone: phone,
        contactLink: contactLink
      };
    });

    // If no Gmail found on home, try contact page
    const hasGmail = analysis.email?.includes('gmail.com');
    if (!hasGmail && analysis.contactLink && analysis.contactLink !== url) {
      console.log(`🔍 No Gmail on home, trying contact page: ${analysis.contactLink}`);
      try {
        await page.goto(analysis.contactLink, { waitUntil: 'networkidle2', timeout: 15000 });
        const contactEmail = await page.evaluate(() => {
          const html = document.documentElement.innerHTML;
          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
          const foundEmails = html.match(emailRegex) || [];
          
          const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'))
            .map(a => a.href.replace('mailto:', '').split('?')[0]);
          
          const allEmails = [...new Set([...foundEmails, ...mailtoLinks])];
          const valid = allEmails.filter(e => {
            const isImage = /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e);
            return !isImage && e.length < 50 && !e.includes('example.com');
          });
          return valid.find(e => e.includes('gmail.com')) || valid[0] || null;
        });
        if (contactEmail) {
          const isBetterGmail = contactEmail.includes('gmail.com');
          if (isBetterGmail || !analysis.email) {
            analysis.email = contactEmail;
          }
        }
      } catch (e) {
        console.log(`⚠️ Failed to scrape contact page: ${e.message}`);
      }
    }

    return analysis;
  } catch (err) {
    console.error(`Error analyzing ${url}:`, err.message);
    return { hasWebsite: true, bookingSystem: false, seoScore: 45, mobileFriendly: true, issues: ["Low SEO optimization", "No online booking"], email: null, phone: null };
  }
};

const calculateLeadIntelligence = (lead, analysis) => {
  let score = 0;
  
  if (!lead.website) {
    score += 40;
  } else {
    if (!analysis.bookingSystem) score += 25;
    if (analysis.seoScore < 50) score += 20;
    if (analysis.mobileFriendly === false) score += 15;
  }

  let intent = "Low Priority";
  if (score > 80) intent = "🔥 High Intent";
  else if (score > 60) intent = "Warm Lead";

  return { score, intent, reasons: analysis.issues || [] };
};

export const runScraper = async (niche, location) => {
  console.log(`🚀 Starting Lead Intelligence Scrape for ${niche} in ${location}...`);
  
  // In production (e.g. a Hostinger VPS) Puppeteer's bundled Chromium is often
  // missing or lacks system libraries. Set PUPPETEER_EXECUTABLE_PATH to the
  // server's installed Chromium/Chrome there. Locally the env var is unset, so
  // Puppeteer resolves its own bundled Chromium exactly as before — no behavior
  // change in development.
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 120000,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    // --disable-dev-shm-usage prevents Chromium crashes on servers with a small
    // /dev/shm (common on VPS/containers). It only affects stability, not the
    // pages loaded or the data scraped.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080']
  });
  
  const page = await browser.newPage();
  const analysisPage = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  // Present as a real desktop browser and pre-accept Google's consent wall.
  // Otherwise headless Chrome is served a JS challenge that never renders the list.
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
  await page.setCookie(
    { name: 'CONSENT', value: 'YES+cb.20210328-17-p0.en+FX+' + Math.floor(Math.random() * 999), domain: '.google.com' },
    { name: 'SOCS', value: 'CAISHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiA_LyfBg', domain: '.google.com' }
  );

  try {
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(niche + ' in ' + location)}?hl=en&gl=us`;
    // networkidle2 never fires on Maps (it keeps long-poll connections open) and
    // caused navigation timeouts. Wait for the DOM, then for the results feed itself.
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const feedReady = await page.waitForSelector('div[role="feed"]', { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!feedReady) {
      console.warn('⚠️ Results feed did not appear (possible consent wall or single-place redirect).');
    }

    // Adaptive scroll: keep scrolling the feed until the number of result cards
    // stops growing (3 stable rounds) or we have plenty. The old fixed 4-scroll
    // loop stopped far too early and, with the stale card selector, yielded ~1 lead.
    const targetCards = Math.max((parseInt(process.env.SCRAPE_MAX_LEADS) || 50) * 3, 30);
    let stableRounds = 0;
    let lastCount = 0;
    for (let i = 0; i < 25 && stableRounds < 3; i++) {
      const count = await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollTo(0, feed.scrollHeight);
        return document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]').length;
      });
      if (count >= targetCards) break;
      stableRounds = count === lastCount ? stableRounds + 1 : 0;
      lastCount = count;
      await new Promise(r => setTimeout(r, 1500));
    }

    const rawLeads = await page.evaluate(() => {
      // Google Maps renders each result as <a class="hfpxzc" aria-label="Name">
      // inside div[role="feed"]. Fall back through older/alternate structures so a
      // single class rename can't silently collapse results to one (the original bug).
      let anchors = Array.from(document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]'));
      if (anchors.length === 0) anchors = Array.from(document.querySelectorAll('a.hfpxzc'));

      let cards;
      if (anchors.length > 0) {
        cards = anchors.map(a => a.closest('div.Nv2PK') || a.parentElement || a);
      } else {
        // Last-resort fallbacks to the historical selectors.
        cards = Array.from(document.querySelectorAll('div.Nv2PK, div[role="article"]'));
      }

      const seen = new Set();
      const results = [];

      cards.forEach((el) => {
        if (!el) return;

        const placeAnchor = el.querySelector('a[href*="/maps/place/"], a.hfpxzc');
        const name = (placeAnchor?.getAttribute('aria-label')
          || el.querySelector('.qBF1Pd, .fontHeadlineSmall, h1')?.innerText
          || el.getAttribute('aria-label')
          || '').trim();
        if (!name) return;

        // De-dupe repeated cards within the feed (prevents the ON CONFLICT collapse
        // from being the only thing standing between us and duplicate work).
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);

        // Website: only a genuine external site counts — NEVER a google.com/maps link
        // (the old fallback grabbed the Maps place URL and stored it as the website).
        let website = null;
        const links = Array.from(el.querySelectorAll('a[href]'));
        const ext = links.find(a => {
          const href = a.href || '';
          return href.startsWith('http')
            && !href.includes('google.com')
            && !href.includes('maps.google')
            && !href.includes('gstatic.com');
        });
        if (ext) website = ext.href;

        // Rating + reviews from the accessible label, e.g. "4.5 stars 128 reviews".
        let rating = 0, reviews_count = 0;
        const ratingEl = el.querySelector('span[role="img"][aria-label*="star" i], span[aria-label*="star" i]');
        const ratingLabel = ratingEl?.getAttribute('aria-label') || '';
        const rm = ratingLabel.match(/([\d.]+)\s*star/i);
        if (rm) rating = parseFloat(rm[1]) || 0;
        const reviewsLabel = el.querySelector('span[aria-label*="review" i]')?.getAttribute('aria-label') || ratingLabel;
        const vm = reviewsLabel.match(/([\d,]+)\s*review/i);
        if (vm) reviews_count = parseInt(vm[1].replace(/,/g, '')) || 0;
        if (!rating) rating = parseFloat(el.querySelector('.MW4etd')?.innerText || '') || 0;
        if (!reviews_count) reviews_count = parseInt((el.querySelector('.UY7F9')?.innerText || '').replace(/[^0-9]/g, '')) || 0;

        // Phone: prefer a tel: link, else regex over the card text.
        let phone = null;
        const telLink = el.querySelector('a[href^="tel:"]');
        if (telLink) phone = telLink.href.replace('tel:', '').split('?')[0].trim();
        if (!phone) {
          const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{3,5}/g;
          phone = (el.innerText.match(phoneRegex) || []).filter(p => {
            const digits = p.replace(/[^0-9]/g, '');
            if (digits.length < 7 || digits.length > 15) return false;
            const sep = (p.match(/[-.\s()]/g) || []).length;
            return sep >= 2 || p.startsWith('+') || p.includes('(');
          })[0] || null;
        }

        // Address: first text line that looks like a street/area.
        const lines = el.innerText.split('\n').map(l => l.trim()).filter(Boolean);
        const address = lines.find(line =>
          line.length > 8
          && !line.includes('★')
          && !/rating/i.test(line)
          && !line.includes('£') && !line.includes('$')
          && !/^\+?\d[\d\s\-()]{7,}$/.test(line)
          && (/\d/.test(line) || /(road|street|avenue|lane|drive|way|court|place|boulevard|square|highway|route)/i.test(line))
        ) || null;

        results.push({ business_name: name, website, rating, reviews_count, phone, address });
      });

      return results;
    });

    console.log(`📋 Extracted ${rawLeads.length} unique businesses from Google Maps for "${niche} in ${location}"`);

    const MAX_LEADS = parseInt(process.env.SCRAPE_MAX_LEADS) || 50;

    const processedLeads = [];
    for (const lead of rawLeads.slice(0, MAX_LEADS)) {
      // 1. Strict Aggregator Removal
      if (isAggregator(lead)) {
        console.log(`❌ Removed Aggregator: ${lead.business_name} (${lead.website})`);
        continue;
      }

      // 2. Secondary Validation
      if (lead.website && !isRealBusiness(lead)) {
        console.log(`⚠️ Invalid Business URL (Aggregator sub-page): ${lead.website}`);
        continue;
      }

      // 3. Lead Intelligence Analysis
      console.log(`🧠 Analyzing: ${lead.business_name}...`);
      const analysis = await analyzeWebsitePotential(analysisPage, lead.website);
      const intel = calculateLeadIntelligence(lead, analysis);

      // If no website, try to find email/phone via Google search
      let enrichedEmail = analysis.email;
      let enrichedPhone = lead.phone || analysis.phone;
      if (!lead.website) {
        console.log(`🔍 No website for ${lead.business_name}, searching for contact info...`);
        const extra = await findEmailAndPhoneWithoutWebsite(analysisPage, lead.business_name, location);
        if (extra.email) enrichedEmail = extra.email;
        if (extra.phone) enrichedPhone = extra.phone;
      }

      // Try Apollo enrichment for email/phone
      console.log(`🔍 Apollo enrichment for ${lead.business_name}...`);
      const apolloData = await enrichLeadWithApollo({
        business_name: lead.business_name,
        website: lead.website,
      });
      if (apolloData?.email) {
        const isGmail = apolloData.email.includes('gmail.com');
        const currentIsGmail = enrichedEmail?.includes('gmail.com');
        if (!enrichedEmail || (isGmail && !currentIsGmail)) {
          enrichedEmail = apolloData.email;
          console.log(`✅ Apollo email found: ${enrichedEmail}`);
        }
      }
      if (apolloData?.phone && !enrichedPhone) {
        enrichedPhone = apolloData.phone;
      }

      const enrichedLead = {
        ...lead,
        email: enrichedEmail,
        phone: enrichedPhone,
        score: intel.score,
        intent: intel.intent,
        audit_details: { 
          reasons: intel.reasons,
          analysis: analysis
        }
      };

      processedLeads.push(enrichedLead);

      await query(
        `INSERT INTO leads (business_name, website, phone, email, address, rating, reviews_count, niche, location, score, audit_details) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
         ON CONFLICT (business_name, location) DO UPDATE SET 
         email = EXCLUDED.email, 
         phone = EXCLUDED.phone,
         score = EXCLUDED.score, 
         audit_details = EXCLUDED.audit_details`,
        [
          enrichedLead.business_name, 
          enrichedLead.website, 
          enrichedLead.phone, 
          enrichedLead.email,
          enrichedLead.address,
          enrichedLead.rating,
          enrichedLead.reviews_count,
          niche, 
          location, 
          enrichedLead.score, 
          JSON.stringify(enrichedLead.audit_details)
        ]
      );
    }

    return processedLeads;
  } catch (error) {
    console.error('❌ Scraper error:', error);
    throw error;
  } finally {
    await browser.close();
  }
};
