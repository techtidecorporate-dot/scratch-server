import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const isGroq = process.env.OPENAI_API_KEY?.startsWith('gsk_');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: isGroq ? 'https://api.groq.com/openai/v1' : undefined
});

export const analyzeWebsite = async (businessName, websiteUrl, websiteContent = '') => {
  try {
    const prompt = `
      Analyze this business lead for a web development agency:
      Business: ${businessName}
      Website: ${websiteUrl}
      
      Tasks:
      1. Rate the "Pain Level" (0-100). Higher if the site looks old, lacks mobile optimization, or is an aggregator link.
      2. Identify 3 specific technical gaps.
      3. Write a "Power Hook" for a cold email.
      
      Return as JSON: { "score": number, "issues": string[], "hook": string }
    `;

    const response = await openai.chat.completions.create({
      model: isGroq ? "llama3-8b-8192" : "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a senior sales engineer. You find technical flaws that cost businesses money." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error('❌ AI Analysis failed:', error);
    return {
      score: 65,
      issues: ["Needs Technical Audit"],
      hook: `Hi ${businessName}, I found some potential improvements for ${websiteUrl}.`
    };
  }
};

export const enrichLeadWithApollo = async (lead) => {
  try {
    const apiKey = process.env.APOLLO_API_KEY;
    if (!apiKey) {
      console.log('⚠️ Apollo API key not configured');
      return null;
    }

    let domain = null;
    if (lead.website) {
      try {
        domain = new URL(lead.website).hostname.replace('www.', '');
      } catch (e) {
        console.log(`⚠️ Could not parse domain from ${lead.website}`);
      }
    }

    const details = {
      organization_name: lead.business_name,
    };
    if (domain) details.domain = domain;

    const response = await fetch('https://api.apollo.io/api/v1/people/bulk_match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        reveal_personal_emails: true,
        reveal_phone: true,
        details: [details],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status === 403 && errText.includes('free plan')) {
        console.log(`⚠️ Apollo enrichment skipped: ${lead?.business_name || ''} — API key needs upgrade (free plan doesn't allow bulk_match). Email/phone from website will be used instead.`);
      } else {
        console.log(`⚠️ Apollo API error: ${response.status} ${response.statusText} — ${errText}`);
      }
      return null;
    }

    const data = await response.json();

    if (data?.people?.length > 0) {
      const personWithGmail = data.people.find(p => p.email?.includes('gmail.com'));
      const person = personWithGmail || data.people[0];
      console.log(`✅ Apollo found: ${person.email || 'no email'} for ${lead.business_name}`);
      return {
        email: person.email || null,
        phone: person.phone || null,
        firstName: person.first_name || null,
        lastName: person.last_name || null,
        title: person.title || null,
        linkedinUrl: person.linkedin_url || null,
      };
    }

    console.log(`ℹ️ Apollo: no people found for ${lead.business_name}`);
    return null;
  } catch (error) {
    console.error('❌ Apollo enrichment failed:', error.message);
    return null;
  }
};
