import chromium from "@sparticuz/chromium";
import puppeteerCore from "puppeteer-core";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import Handlebars from "handlebars";
import * as jsonc from "jsonc-parser";
import { jsonrepair } from "jsonrepair";

const RESUME_SYSTEM_PROMPT = `You output ONLY a single valid JSON object. No markdown, no code fences, no explanation text.
Required keys: title (string), summary (string, one line only — sentences separated by spaces, no line breaks), skills (object mapping category names to string arrays), experience (array of {title: string, details: string[]}).
Escape double quotes inside strings as \\". No trailing commas.`;

const RESUME_JSON_SCHEMA = {
  name: "resume_content",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      skills: {
        type: "object",
        additionalProperties: {
          type: "array",
          items: { type: "string" },
        },
      },
      experience: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            details: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["title", "details"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "summary", "skills", "experience"],
    additionalProperties: false,
  },
};

const normalizeJsonText = (text) =>
  text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\uFEFF/g, "");

const buildRetryPrompt = (prompt) =>
  `${prompt}

IMPORTANT RETRY: Return ONLY valid JSON. Keep the same content requirements (skills count, bullet counts per job, summary length, word counts, full Tier-1 JD coverage in recent experience bullets). Do not reduce scope or weaken bullets. Summary must be one line with sentences separated by spaces. Escape double quotes inside strings as \\".`;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const getLocalChromeExecutablePath = () => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  // Common locations (best-effort). If none exist, puppeteer-core may still work via `channel`.
  const candidates = [];

  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env["PROGRAMFILES(X86)"];
    const localAppData = process.env.LOCALAPPDATA;

    if (programFiles) {
      candidates.push(path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    if (programFilesX86) {
      candidates.push(path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    if (localAppData) {
      candidates.push(path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    // linux
    candidates.push("/usr/bin/google-chrome");
    candidates.push("/usr/bin/google-chrome-stable");
    candidates.push("/usr/bin/chromium-browser");
    candidates.push("/usr/bin/chromium");
  }

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }

  return null;
};

// Move utility functions outside handler to avoid recreation
const calculateYears = (experience) => {
  if (!experience || experience.length === 0) return 0;
  
  const parseDate = (dateStr) => {
    if (!dateStr) return null;
    
    // Handle "Present"
    const trimmed = dateStr.trim();
    if (trimmed.toLowerCase() === "present") return new Date();
    
    // Handle "MM/YYYY" format (e.g., "12/2018", "07/2018")
    const mmYyyyMatch = trimmed.match(/^(\d{1,2})\/(\d{4})\s*$/);
    if (mmYyyyMatch) {
      const month = parseInt(mmYyyyMatch[1], 10) - 1; // JS months are 0-indexed
      const year = parseInt(mmYyyyMatch[2], 10);
      return new Date(year, month, 1); // First day of the month
    }
    
    // Handle other formats - try standard Date parsing
    const parsed = new Date(trimmed);
    
    // Check if date is valid
    if (isNaN(parsed.getTime())) {
      console.warn(`Failed to parse date: "${dateStr}"`);
      return null;
    }
    
    return parsed;
  };
  
  // Parse all dates and filter out invalid ones
  const validDates = experience
    .map(job => parseDate(job.start_date))
    .filter(date => date !== null);
  
  if (validDates.length === 0) {
    console.warn("No valid dates found in experience");
    return 0;
  }
  
  // Find earliest date
  const earliest = validDates.reduce((min, date) => {
    return date < min ? date : min;
  }, validDates[0]);
  
  const years = (new Date() - earliest) / (1000 * 60 * 60 * 24 * 365);
  return Math.max(8, Math.round(years));
};

// Profiles whose template renders raw HTML (triple-brace {{{summary}}} / {{{this}}}) and
// can therefore show bolded keywords. Adding a profile here WITHOUT switching its template
// to triple-brace prints literal <strong> tags on the PDF.
const BOLD_KEYWORD_PROFILES = new Set(["Kevin_Lee"]);

const escapeHtml = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const escapeRegExp = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One alternation over every skill the model produced, longest-first so "Spring Boot" wins
// over "Spring" and "JavaScript" over "Java".
const buildKeywordRegex = (skills) => {
  const terms = [
    ...new Set(
      Object.values(skills || {})
        .flat()
        .filter((t) => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t.length >= 2)
    ),
  ].sort((a, b) => b.length - a.length);

  if (!terms.length) return null;

  // \b is useless here: it would reject "C++", "C#", ".NET" and split "Node.js".
  // Instead require that a match isn't glued to another identifier character.
  return new RegExp(
    `(?<![A-Za-z0-9+#.])(?:${terms.map(escapeRegExp).join("|")})(?![A-Za-z0-9+#])`,
    "gi"
  );
};

// Returns HTML: everything is escaped, then matches are wrapped. Escaping first and
// injecting after would corrupt tags; this interleaves so "JPMorgan Chase & Co." stays safe.
const boldKeywords = (text, regex) => {
  if (typeof text !== "string" || !text) return escapeHtml(text);
  if (!regex) return escapeHtml(text);

  let out = "";
  let last = 0;
  let match;
  regex.lastIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    out += escapeHtml(text.slice(last, match.index));
    out += `<strong>${escapeHtml(match[0])}</strong>`;
    last = match.index + match[0].length;
  }

  return out + escapeHtml(text.slice(last));
};

// Cache template compilation
const templateCacheByPath = new Map();

const getTemplatePathForProfile = (profileName) => {
  const templatesDir = path.join(process.cwd(), "templates");
  const defaultTemplatePath = path.join(templatesDir, "Resume-1.html");

  if (typeof profileName !== "string" || !profileName.trim()) {
    return defaultTemplatePath;
  }

  return path.join(templatesDir, `${profileName.trim()}.html`);
};

const getTemplate = (profileName) => {
  let currentTemplatePath = getTemplatePathForProfile(profileName);
  const defaultTemplatePath = path.join(process.cwd(), "templates", "Resume-1.html");

  if (!fs.existsSync(currentTemplatePath)) {
    currentTemplatePath = defaultTemplatePath;
  }

  if (!templateCacheByPath.has(currentTemplatePath)) {
    const templateSource = fs.readFileSync(currentTemplatePath, "utf-8");

    // Register Handlebars helpers (idempotent, safe to call multiple times)
    Handlebars.registerHelper('formatKey', function(key) {
      return key;
    });

    Handlebars.registerHelper('join', function(array, separator) {
      if (Array.isArray(array)) {
        return array.join(separator);
      }
      return '';
    });

    templateCacheByPath.set(currentTemplatePath, Handlebars.compile(templateSource));
  }

  return templateCacheByPath.get(currentTemplatePath);
};

// Cache profile data in memory to avoid repeated file reads
const profileCache = new Map();

const loadProfile = (profileName) => {
  if (profileCache.has(profileName)) {
    return profileCache.get(profileName);
  }
  
  const profilePath = path.join(process.cwd(), "resumes", `${profileName}.json`);
  if (!fs.existsSync(profilePath)) {
    return null;
  }
  
  const profileData = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
  profileCache.set(profileName, profileData);
  return profileData;
};

const extractJsonObject = (text) => {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
};

const escapeControlCharsInJsonStrings = (jsonText) => {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];

    if (!inString) {
      result += ch;
      if (ch === '"') inString = true;
      escaped = false;
      continue;
    }

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      result += ch;
      inString = false;
      continue;
    }

    if (ch === "\n") result += "\\n";
    else if (ch === "\r") continue;
    else if (ch === "\t") result += "\\t";
    else if (ch.charCodeAt(0) < 32) continue;
    else result += ch;
  }

  return result;
};

const parseJsonCandidate = (candidate) => {
  try {
    return JSON.parse(candidate);
  } catch {
    // continue
  }

  try {
    return JSON.parse(jsonrepair(candidate));
  } catch {
    // continue
  }

  const jsoncErrors = [];
  const jsoncResult = jsonc.parse(candidate, jsoncErrors);
  if (jsoncErrors.length === 0 && jsoncResult !== undefined) {
    return jsoncResult;
  }

  return null;
};

const tryParseResumeJson = (rawContent) => {
  if (!rawContent || !String(rawContent).trim()) {
    return { ok: false, error: "Empty AI response" };
  }

  let content = normalizeJsonText(String(rawContent))
    .replace(/```(?:json|javascript)?\s*/gi, "")
    .replace(/```\s*/g, "")
    .replace(/^(here is|here's|this is|the json is):?\s*/gi, "")
    .trim();

  const candidates = [];
  if (content.startsWith("{")) {
    candidates.push(content);
  }

  const extracted = extractJsonObject(content);
  if (extracted && !candidates.includes(extracted)) {
    candidates.push(extracted);
  }

  if (!candidates.length) {
    return { ok: false, error: "No JSON object found in response" };
  }

  for (const base of candidates) {
    const variants = [
      base,
      base.replace(/,(\s*[}\]])/g, "$1").replace(/,\s*,/g, ","),
      escapeControlCharsInJsonStrings(base),
      escapeControlCharsInJsonStrings(
        base.replace(/,(\s*[}\]])/g, "$1").replace(/,\s*,/g, ",")
      ),
    ];

    for (const candidate of variants) {
      const data = parseJsonCandidate(candidate);
      if (data && typeof data === "object") {
        return { ok: true, data };
      }
    }
  }

  return { ok: false, error: "JSON parse failed after repair attempts" };
};

// Mirrors the HARD CAP in prompt section 4. The prompt asks for <= 40; this is the
// backstop for when the model overshoots anyway.
const SKILLS_HARD_CAP = 40;

const countSkills = (skills) =>
  Object.values(skills || {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);

const capSkills = (skills, cap = SKILLS_HARD_CAP) => {
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) return skills;

  const capped = {};
  for (const [key, value] of Object.entries(skills)) {
    capped[key] = Array.isArray(value) ? [...value] : value;
  }

  let total = countSkills(capped);
  if (total <= cap) return capped;

  const before = total;

  // Section 4 orders each category Tier-1 first, so the tail of a category is its
  // least JD-critical entry. Always trim the currently-largest category to keep
  // categories balanced, and never empty one out.
  while (total > cap) {
    let largestKey = null;
    let largestLen = 1;

    for (const [key, value] of Object.entries(capped)) {
      if (Array.isArray(value) && value.length > largestLen) {
        largestLen = value.length;
        largestKey = key;
      }
    }

    if (!largestKey) break;

    capped[largestKey].pop();
    total--;
  }

  console.warn(`⚠️ Skills over cap: ${before} -> trimmed to ${total} (cap ${cap})`);
  return capped;
};

const normalizeResumeContent = (resumeContent) => {
  if (resumeContent.skills && typeof resumeContent.skills === "object") {
    resumeContent.skills = capSkills(resumeContent.skills);
  }

  if (Array.isArray(resumeContent.summary)) {
    resumeContent.summary = resumeContent.summary.filter(Boolean).join(" ");
  } else if (typeof resumeContent.summary === "string") {
    resumeContent.summary = resumeContent.summary.replace(/\s+/g, " ").trim();
  }

  if (Array.isArray(resumeContent.experience)) {
    resumeContent.experience = resumeContent.experience.map((exp) => ({
      ...exp,
      details: Array.isArray(exp.details)
        ? exp.details.map((d) => String(d).replace(/\s+/g, " ").trim())
        : [],
    }));
  }

  return resumeContent;
};

const getOpenAIMessageText = (choice) => {
  const message = choice?.message;
  if (!message) return "";

  if (message.refusal) {
    console.warn("OpenAI refusal:", message.refusal);
    return "";
  }

  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        return part?.text ?? "";
      })
      .join("")
      .trim();
  }

  return "";
};

const isJsonSchemaUnsupported = (err) => {
  const msg = `${err?.message || ""} ${err?.error?.message || ""}`.toLowerCase();
  return (
    err?.status === 400 &&
    (msg.includes("json_schema") ||
      msg.includes("response_format") ||
      msg.includes("structured outputs"))
  );
};

// Call OpenAI with timeout & retries
async function callOpenAI(promptOrMessages, options = {}) {
  const {
    model = null,
    maxTokens = 16384,
    retries = 2,
    timeoutMs = 180000,
    jsonMode = false,
    useSchema = false,
  } = options;
  let attemptsLeft = retries;

  while (attemptsLeft > 0) {
    try {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("Missing OPENAI_API_KEY");
      }

      let messages = [];

      if (typeof promptOrMessages === "string") {
        messages = [{ role: "user", content: promptOrMessages }];
      } else if (Array.isArray(promptOrMessages)) {
        const systemMsg = promptOrMessages.find((msg) => msg.role === "system");
        if (systemMsg) {
          const systemContent = Array.isArray(systemMsg.content)
            ? systemMsg.content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("\n")
            : systemMsg.content;
          messages.push({ role: "system", content: systemContent });
        }
        const rest = promptOrMessages
          .filter((msg) => msg.role !== "system")
          .map((msg) => ({
            role: msg.role === "assistant" ? "assistant" : "user",
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          }));
        messages.push(...rest);
      } else {
        messages = [{ role: "user", content: String(promptOrMessages) }];
      }

      const baseParams = {
        model: model || process.env.OPENAI_MODEL || "gpt-5-mini",
        max_completion_tokens: maxTokens,
        temperature: 1,
        messages,
      };

      const formatAttempts = [];
      if (jsonMode && useSchema) {
        formatAttempts.push({
          response_format: {
            type: "json_schema",
            json_schema: RESUME_JSON_SCHEMA,
          },
        });
      }
      if (jsonMode) {
        formatAttempts.push({ response_format: { type: "json_object" } });
      }
      formatAttempts.push({});

      let lastFormatError = null;
      for (const formatParams of formatAttempts) {
        try {
          const completion = await Promise.race([
            openai.chat.completions.create({ ...baseParams, ...formatParams }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("OpenAI request timed out")), timeoutMs)
            ),
          ]);

          const choice = completion.choices?.[0];
          const text = getOpenAIMessageText(choice);

          return {
            content: [{ type: "text", text }],
            stop_reason: choice?.finish_reason ?? "stop",
            usage: completion.usage
              ? {
                  input_tokens: completion.usage.prompt_tokens,
                  output_tokens: completion.usage.completion_tokens,
                }
              : undefined,
            model: completion.model,
          };
        } catch (err) {
          if (formatParams.response_format && isJsonSchemaUnsupported(err)) {
            lastFormatError = err;
            console.warn("Structured output format failed, trying fallback:", err.message);
            continue;
          }
          throw err;
        }
      }

      throw lastFormatError || new Error("OpenAI request failed");
    } catch (err) {
      attemptsLeft--;
      if (attemptsLeft === 0) throw err;
      console.log(`Retrying OpenAI call... (${attemptsLeft} attempts left)`);
    }
  }
}

async function repairResumeJsonWithAI(brokenJsonText, callOptions) {
  const snippet = brokenJsonText.slice(0, 20000);
  const repairMessages = [
    {
      role: "system",
      content:
        "You fix malformed JSON. Return ONLY a valid JSON object with keys: title, summary, skills, experience. No markdown.",
    },
    {
      role: "user",
      content: `Repair this into valid JSON. Preserve all resume content. Output JSON only:\n\n${snippet}`,
    },
  ];

  const response = await callOpenAI(repairMessages, {
    ...callOptions,
    jsonMode: true,
    useSchema: false,
    maxTokens: 16384,
  });

  return response.content?.[0]?.text ?? "";
}

async function generateResumeContent(userPrompt, callOptions) {
  const messages = [
    { role: "system", content: RESUME_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const run = async (msgs, opts) => {
    const response = await callOpenAI(msgs, opts);
    return {
      text: response.content?.[0]?.text ?? "",
      response,
    };
  };

  let { text, response } = await run(messages, { ...callOptions, useSchema: true });

  if (!text) {
    console.warn("Empty AI response on first attempt, retrying...");
    ({ text, response } = await run(messages, { ...callOptions, useSchema: false }));
  }

  let parsed = tryParseResumeJson(text);
  if (parsed.ok) return { data: parsed.data, response };

  console.log("🔄 Retry after JSON parse failure (same content requirements)...");
  const retryMessages = [
    { role: "system", content: RESUME_SYSTEM_PROMPT },
    { role: "user", content: buildRetryPrompt(userPrompt) },
  ];
  ({ text, response } = await run(retryMessages, { ...callOptions, useSchema: true }));

  parsed = tryParseResumeJson(text);
  if (parsed.ok) return { data: parsed.data, response };

  if (text) {
    console.log("🔄 JSON repair pass...");
    const repairedText = await repairResumeJsonWithAI(text, callOptions);
    parsed = tryParseResumeJson(repairedText);
    if (parsed.ok) return { data: parsed.data, response };
  }

  return { data: null, response, text, error: parsed.error || "Unknown parse error" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    console.log("OpenAI config:", {
      hasApiKey: Boolean(process.env.OPENAI_API_KEY),
      apiKeyLength: process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.length : 0,
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
    });

    const { profile, jd, company, role } = req.body;

    if (!profile) return res.status(400).send("Profile required");
    if (!jd) return res.status(400).send("Job description required");
    if (!company) return res.status(400).send("Company name required");
    if (!role) return res.status(400).send("Role name required");

    // Load profile JSON (using cache)
    console.log(`Loading profile: ${profile}`);
    const profileData = loadProfile(profile);
    
    if (!profileData) {
      return res.status(404).send(`Profile "${profile}" not found`);
    }

    const yearsOfExperience = Math.max(8, calculateYears(profileData.experience) - 1);
    const jdForPrompt =
      typeof jd === "string" && jd.length > 8000
        ? `${jd.slice(0, 8000)}\n\n[Job description truncated for length.]`
        : jd;

    const hasGoogleExperience =
      Array.isArray(profileData.experience) &&
      profileData.experience.some((job) => /\bgoogle\b/i.test(job.company || ""));

    const googleTechRealismSection = hasGoogleExperience
      ? `
**6B. GOOGLE TECHNOLOGY REALISM (STRICT — CANDIDATE HAS GOOGLE WORK HISTORY)**

Google does NOT use the technologies on the left of each pair. In bullets for the Google employment entry, NEVER name a left-side item — write the Google equivalent instead.

MANDATORY SUBSTITUTIONS (Google entry bullets):
- React -> Angular
- React Native -> Kotlin (Android) or Swift (iOS)
- C#, Ruby, PHP, and JavaScript/TypeScript backend frameworks or libraries (Node.js, Express, NestJS, .NET, Rails, Laravel) -> Java, Go, or C++
- AWS, Azure (and their services) -> GCP equivalents
- AI tooling -> Google Gemini (NEVER Copilot, Cursor, Claude, ChatGPT)

SKILLS COUPLING (CRITICAL):
- Every substitute used in a Google bullet MUST also appear in SKILLS (section 4), even if the JOB DESCRIPTION never mentions it
- Place it in the track-appropriate existing category — do NOT create a Google-specific category
- This is the ONE exception to JD-driven skills selection: the candidate's real Google employment is the supporting evidence
- Substitutes rank WITH Tier-1 must-haves under the section 4 HARD CAP — never drop one to meet the cap; drop aspirational/adjacent/Tier-2 instead
- Adding a substitute does NOT raise the 40-skill cap. If the list is full, the substitute displaces a lower-priority skill rather than extending the list

SCOPE (STRICT):
- Applies ONLY to the Google employment entry. Other employers keep their authentic stacks — if a non-Google job genuinely used React or AWS, that stays
- Frontend JavaScript/TypeScript stays valid at Google when paired with Angular. Substitute JS/TS only for BACKEND work
- Do NOT reshape TITLE or SUMMARY into a Google-only stack unless the rest of the work history supports it

FORBIDDEN in Google bullets:
- React, React Native, Vue.js, Next.js
- C#, .NET, Ruby, Ruby on Rails, PHP, Laravel
- Node.js, Express, NestJS, or any JS/TS backend runtime
- AWS, Azure, Lambda, EC2, S3, DynamoDB, Azure DevOps
- GitHub Copilot, Cursor, Claude, ChatGPT, OpenAI

Section 6 timeline realism still applies (Angular: 2016 | Go: 2009 | Kotlin: 2011 | Swift: 2014 | GCP: 2011 | Gemini: 2023).
`
      : "";

    const googleChecklistItem = hasGoogleExperience
      ? `
- Google entries name only Google-real technologies, and every substitute also appears in SKILLS`
      : "";

    // AI PROMPT: Realism-first ATS resume generation (all SWE tracks)
    const prompt = `Realism-first ATS resume expert for software engineering roles across all tracks (full stack, frontend, backend, QA/SDET, AI/ML, DevOps/SRE, data engineering/analytics, Salesforce, platform, security, and general software engineer). Generate resume JSON: {"title":"...","summary":"...","skills":{...},"experience":[...]}

**OUTPUT: ONLY valid JSON, no markdown/explanations.**

**TARGET APPLICATION:**
Target Role (primary tailoring anchor): ${role}

**PROFILE:**
Candidate: ${profileData.name} | ${profileData.email} | ${profileData.phone} | ${profileData.location}
Experience: ${yearsOfExperience} years | Most Recent: ${profileData.experience[0]?.title || 'N/A'}

**WORK:**
${profileData.experience.map((job, idx) => {
  let workEntry = `${idx + 1}. ${job.company} | ${job.title || ''} | ${job.start_date} - ${job.end_date}`;
  if (job.details && job.details.length > 0) {
    workEntry += '\n   Details:\n' + job.details.map((detail, detailIdx) => `   - ${detail}`).join('\n');
  }
  return workEntry;
}).join('\n\n')}

**EDUCATION:**
${profileData.education.map(edu => `${edu.degree}, ${edu.school} (${edu.start_year}-${edu.end_year})`).join('\n')}

**JOB DESCRIPTION:**
${jdForPrompt}

**INSTRUCTIONS (REALISM-FIRST ATS ENGINE)**

**GLOBAL — TECHNICAL-ONLY TAILORING (CRITICAL)**
Tailor ONLY via technical alignment to the JOB DESCRIPTION and TARGET ROLE.

INCLUDE in analysis and resume output:
- Technical skills, tools, stacks, platforms, methodologies, certifications that are engineering-relevant
- Technical experience areas and engineering responsibilities from the JD
- Engineering seniority/scope signals (years of hands-on experience, lead/architect/own/design systems — not HR seniority fluff)

IGNORE completely — do NOT extract, prioritize, or reflect in title, summary, skills, or experience:
- Work arrangement: remote, hybrid, on-site, office location, relocation, timezone overlap
- Employment terms: contract length, permanent vs contract, notice period, work authorization, visa sponsorship
- Spoken/written language requirements: English C1, Polish, bilingual, etc. (programming languages ARE technical — include those)
- Travel: occasional office visits, % travel, client site visits
- Soft HR requirements: culture fit, personality traits, "team player", communication skills (unless tied to a technical responsibility like technical leadership or cross-team architecture)
- Benefits, salary, PTO, equipment, dress code, hours per week
- Non-technical education requirements unless directly engineering-relevant (e.g., CS degree as proxy for fundamentals — still do not write "fluent in English" in summary)

NEVER mention in title, summary, skills, or experience bullets:
- The hiring employer name from the JD (even if stated in the job posting)
- Phrases like "this role", "your team", "your company", "joining [Company]", "excited to contribute at [Company]", or any obvious application-specific tailoring
- Product/brand names unique to the employer unless they already appear in the candidate's work history Details
- Any ignored non-technical JD item listed above

Use generic industry/domain language instead (e.g., "e-commerce platforms", "fintech systems", "healthcare data platforms") when domain context helps ATS fit.
Past employers in WORK history may appear only as employment context — not as flattery toward the company being applied to.

**0. ROLE TRACK (DETECT FIRST — DRIVES ALL SECTIONS)**

Infer the primary engineering track from TARGET ROLE + JOB DESCRIPTION (use TARGET ROLE when it names a specialty; use JD when TARGET ROLE is generic like "Software Engineer").

Supported tracks (pick ONE primary; secondary track only if JD is clearly a hybrid engineering role — NOT remote/hybrid work arrangement):
- fullstack / general software engineer
- frontend
- backend / API
- QA / SDET / test automation
- AI / ML / LLM / data science (engineering-focused)
- DevOps / SRE / platform / cloud infrastructure
- data engineering / analytics engineering / BI engineering
- Salesforce (developer, admin, consultant, architect)
- mobile (iOS/Android/cross-platform) — only if JD or history supports it
- security / AppSec — only if JD or history supports it

TRACK RULES:
- Tailor title, summary, skills categories, and experience bullets to the detected track — NOT default full stack unless that is the target.
- Re-weight emphasis per track (examples):
  - QA/SDET: test strategy, automation frameworks, CI quality gates, regression/performance/API/security testing, defect prevention — NOT feature delivery as primary narrative unless history supports it
  - DevOps/SRE: CI/CD, IaC, observability, reliability, incident response, cost/performance of platforms — NOT UI feature work unless history supports it
  - Data: pipelines, warehousing, modeling, SQL/Spark/dbt-style tooling, data quality, batch/stream processing — NOT generic CRUD app features unless history supports it
  - AI/ML: model lifecycle, training/inference, MLOps, evaluation, responsible AI, production ML systems — NOT listing every LLM buzzword without plausible work
  - Salesforce: Apex, LWC, Flows, integrations (REST/SOAP), declarative vs programmatic delivery, release management — NOT generic web stack unless history supports it
  - Full stack / frontend / backend: product engineering, APIs, UI, system design as appropriate to sub-track
- If candidate history does not support the target track, stay closest to real history and use adjacent, honest framing — never invent a different career.

**1. JD DEEP ANALYSIS — TECHNICAL ONLY (MANDATORY BEFORE WRITING)**

Read the JOB DESCRIPTION and TARGET ROLE. Strip all non-technical items per GLOBAL rules. Build an internal TECHNICAL requirement map only (do not output this map — use it to drive summary, skills, and experience).

A) TECHNICAL REQUIREMENT INVENTORY — extract ONLY:
- Must-have technical skills (programming languages, frameworks, cloud, databases, tools, engineering methodologies)
- Must-have technical experience areas (e.g., "CI/CD ownership", "ETL pipelines", "Salesforce integrations", "LLM production", "performance testing at scale")
- Nice-to-have / preferred technical skills and experiences
- Technical responsibilities (engineering work they expect: build, design, test, deploy, monitor, optimize, integrate, etc.)
- Technical seniority signals: years of relevant hands-on experience, scope words (lead, architect, mentor, own, design, hands-on, expert, proven) in an engineering context
- Level indicators per requirement:
  - exposure / familiarity (used, supported, participated)
  - hands-on / production (built, deployed, maintained, operated)
  - ownership / leadership (designed, led, defined standards, mentored, owned end-to-end)
  - expert / strategic (architected, scaled, multi-team, multi-year systems)

B) PRIORITIZE (technical items only):
- Tier 1 (MUST COVER): explicit technical "required"/"must have", minimum years of technical experience, core engineering responsibilities, repeated technical emphasis in JD
- Tier 2 (SHOULD COVER): preferred technical skills, secondary engineering responsibilities
- Tier 3 (OPTIONAL): vague or generic technical items only if candidate history supports
- NEVER promote non-technical JD lines to any tier

C) LEVEL TARGET (engineering seniority only):
Infer technical seniority the JD expects (e.g., mid, senior, staff) from years of technical experience, TARGET ROLE, and engineering scope language — not from HR or logistics sections.
Every experience bullet for recent roles (most recent 1-2 jobs) must read at or above that level — never generic junior phrasing for a senior JD.

**1B. DOMAIN KEYWORDS (FROM JD ANALYSIS)**

Extract 12-20 Tier-1/Tier-2 keywords and phrases from the requirement map (skills + experience areas + domain terms).

CORE RULE (IMPORTANT):
Domain keywords are NOT mandatory or universal in isolation.
Include in resume ONLY IF:
- Supported by candidate experience OR
- Clearly implied by JD industry/domain (use generic domain terms — never the hiring company name) OR
- Explicitly required by JD AND realistically align with role scope

VALID USAGE EXAMPLES:
- Identity/Security -> ONLY if backend/auth/system/security work exists
- OAuth2 / JWT -> ONLY if authentication systems are present
- GDPR / SOC2 -> ONLY if enterprise/regulatory systems exist
- HIPAA / FHIR -> ONLY if healthcare domain is explicitly relevant
- Data Governance -> ONLY if data-heavy systems exist
- Selenium/Cypress/Playwright/JUnit/TestNG -> ONLY for QA/SDET or test-automation-heavy roles
- Kubernetes/Terraform/Prometheus -> ONLY for DevOps/SRE/platform roles or clear infra ownership
- Spark/dbt/Airflow/Snowflake/BigQuery -> ONLY for data engineering/analytics roles
- Apex/LWC/Salesforce Flows/CPQ -> ONLY for Salesforce roles
- PyTorch/TensorFlow/LLM/RAG/MLOps -> ONLY for AI/ML roles with plausible ML delivery history

FORBIDDEN:
- injecting healthcare keywords into non-healthcare companies
- forcing compliance terms into generic SaaS roles
- keyword stuffing unrelated to experience

FALLBACK RULE:
If not supported, replace with neutral equivalents:
- "secure authentication systems"
- "data access controls"
- "privacy-aware system design"
- "regulated data handling (general)"

**2. TITLE (CAREER CONSISTENCY LOCK)**

Base Title: Most recent job title (first experience entry)
Output title: Base Title.

RULE:
Maintain ONE consistent engineering identity across entire resume for the detected track.

STRICT RULE:
Do NOT transform candidate into an unrelated career path unless experience history supports it.

Allowed title adjustments WITHIN supported evidence (examples):
- fullstack <-> frontend <-> backend <-> software engineer
- QA engineer <-> SDET <-> test automation engineer
- DevOps engineer <-> SRE <-> platform engineer <-> cloud engineer
- data engineer <-> analytics engineer <-> BI developer (if data work exists)
- ML engineer <-> AI engineer <-> applied scientist (engineering) (if ML work exists)
- Salesforce developer <-> Salesforce admin <-> Salesforce consultant (if CRM platform work exists)

FORBIDDEN without evidence:
- full stack developer -> Salesforce architect
- QA engineer -> data engineer
- backend engineer -> DevOps lead (unless infra/CI/CD ownership appears in details)

Prefer TARGET ROLE wording when it matches history; otherwise closest honest title for the track.

**3. SUMMARY (REALISTIC SENIOR NARRATIVE — TRACK-AWARE)**

Write exactly 5-6 complete sentences as one flowing paragraph. Each sentence should be rich and 10-20 words. Do NOT write short one-clause fragments.
SUMMARY JSON RULE: "summary" must be ONE single-line string (all sentences joined with spaces). Never put line breaks inside the summary value.

STRUCTURE (one full sentence each — adapt emphasis to detected track; weave in top Tier-1 JD requirements):
- Sentence 1: [Title] with ${yearsOfExperience}+ years of experience in [track-appropriate scope matching JD domain]
- Sentence 2: Core expertise in 2-3 Tier-1 JD technologies/skills, with how they were applied at production/ownership level (match JD seniority)
- Sentence 3: Flagship achievement with metric when plausible — must reflect a Tier-1 JD responsibility area
- Sentence 4: Secondary Tier-1 or Tier-2 depth (architecture, data, infra, testing, ML, Salesforce platform — per track)
- Sentence 5: Remaining Tier-1 experience areas (scale, reliability, integrations, compliance, etc.) at credible depth
- Sentence 6 (optional — use for 6-sentence summaries only): Leadership/mentoring/Agile + forward-looking alignment to JD priorities

TRACK TONE EXAMPLES (adapt to candidate/JD — do not copy verbatim):
- Full stack: product features across API and UI, system design, delivery metrics
- QA/SDET: test automation, quality gates, regression/performance testing, release confidence
- DevOps/SRE: CI/CD, IaC, observability, uptime, incident reduction, platform scale
- Data: ETL/ELT, warehousing, modeling, data quality, analytics enablement
- AI/ML: production models, MLOps, evaluation, responsible deployment, business impact from ML
- Salesforce: declarative + programmatic solutions, integrations, release management, user adoption

RULES:
- Use connective phrasing: "with strong experience", "Experienced in", "Hands-on with", "Proven technical leader", "Focused on"
- Max 1-2 technical keywords per sentence; weave into natural prose, not lists
- 40% technical / 60% narrative balance
- NO keyword stacking or repeated buzzwords across sentences
- Mix impact levels naturally: small (10-20%), medium (20-50%), rare high (50%+)
- FORBIDDEN: choppy summaries like "Core expertise in X and Y." as a standalone tiny line
- FORBIDDEN in summary: hiring company name, "this position/role", or any wording that signals the resume was written for one specific employer — stay technically strong and employer-neutral

**4. SKILLS (REAL-WORLD STACK MODEL — TRACK-SPECIFIC + JD-ALIGNED)**

30-40 skills across 6-8 categories. Category NAMES and contents must match the detected track.

HARD CAP (OVERRIDES EVERY OTHER RULE IN THIS SECTION):
- Maximum 40 skills TOTAL across all categories combined. Count them before you output.
- A dense JD does NOT license a longer list — the cap is fixed, the JD is not.
- If covering everything would exceed 40, drop in this exact order until at or under 40:
  1. aspirational
  2. adjacent/supporting
  3. Tier-2 preferred
- NEVER drop a Tier-1 must-have to meet the cap.
- If Tier-1 must-haves ALONE exceed 40, output the Tier-1 set only and stop — Tier-1 is the only thing the cap yields to.

JD ALIGNMENT:
- Every Tier-1 must-have skill from section 1 must appear in skills (use exact JD phrasing where reasonable for ATS)
- Tier-2 preferred skills: include when plausible from history AND the cap still allows
- Order categories so Tier-1 skills appear early within each category

Use track-appropriate category sets (pick one set; do not mix unrelated stacks):
- Full stack / frontend / backend: Languages, Frontend, Backend/APIs, Databases, Cloud/DevOps (if used), Practices/Tools
- QA/SDET: Test Automation, Frameworks & Languages, API/Performance/Security Testing, CI/CD & Quality Engineering, Tools & Practices
- DevOps/SRE: Cloud Platforms, IaC, Containers/Orchestration, CI/CD, Observability/Reliability, Scripting & Automation
- Data: SQL & Warehouses, Pipelines/Orchestration, Modeling & Analytics, Cloud Data Services, Engineering Practices
- AI/ML: ML/DL Frameworks, MLOps & Deployment, Data & Feature Engineering, LLM/NLP (only if plausible), Cloud & Tools
- Salesforce: Platform (Apex, LWC, Flows), Integrations, Data/CRM, DevOps/Release, Adjacent Enterprise Tools

REALISM PRINCIPLES (proportions WITHIN the capped list — never a reason to grow it past 40):
- 50-60% primary stack for the target track (real usage only)
- 30-40% adjacent/supporting skills for that track
- 10% aspirational (ONLY if plausible for the role)

STRICT RULES:
- No "everything engineer" syndrome (e.g., do not list full web stack + full Salesforce + full data stack for a single QA role)
- No conflicting ecosystems unrelated to the track
- No repeated keywords across categories
- Must match: job timeline, company type, industry maturity, and detected track

**5. EXPERIENCE (JD-DRIVEN COVERAGE + LEVEL-CALIBRATED ENGINE)**

${profileData.experience.length} entries. Bullet count by seniority (most recent job = entry 1):

BULLET COUNT BY LEVEL:
- Recent senior-level roles (most recent 1-2 jobs; e.g., Senior/Lead/Principal/Staff Engineer, Architect, SDET, DevOps/SRE, Data Engineer, ML Engineer): 7-8 bullets
- Mid-level roles (middle career; e.g., Engineer, Developer, QA Engineer, Analyst without senior prefix): 5-7 bullets
- Early-level roles (oldest jobs; e.g., Junior, Intern, Associate, first industry roles): 4-6 bullets

Use job title, dates, and position in work history to pick the correct range per entry.

**5A. JD REQUIREMENT COVERAGE (CRITICAL — FIXES MISSING/WEAK EXPERIENCE)**

Using the JD requirement map from section 1:

COVERAGE RULES:
- ALL Tier-1 must-have skills AND experience areas must appear somewhere across the resume — prioritize most recent 1-2 jobs.
- At least 70% of Tier-2 preferred items should appear if plausible from candidate history.
- Do NOT leave obvious JD must-haves unaddressed in recent roles when candidate details or title make them plausible.
- Spread coverage across bullets — one bullet can satisfy 2-3 related requirements if written with enough depth.
- If a Tier-1 requirement is not in provided Details, reframe adjacent real work at the required LEVEL (see 5B) — do not skip silently and do not invent unrelated systems.

ALLOCATION (most recent job = entry 1):
- Entry 1: cover 60-70% of Tier-1 requirements (highest JD alignment)
- Entry 2: cover remaining Tier-1 + key Tier-2 items not yet shown
- Older entries: foundational evidence for long-running requirements (years of experience, early adoption) — lighter JD tailoring, still credible

Before finalizing, mentally verify: for each Tier-1 item, which bullet proves it? If none -> add or strengthen a bullet in entry 1 or 2.

**5B. SENIORITY & DEPTH CALIBRATION (REQUIRED LEVEL IN EVERY BULLET)**

Match bullet depth to JD level target AND job seniority in work history.

Each bullet MUST include enough substance to prove competence — not a name-drop. Include ALL that apply:
1. Scope: what system/product/pipeline/test suite/platform (specific, not "the application")
2. Action: designed | architected | led | built | owned | automated | optimized (verb matches seniority)
3. Technology: named tools/stacks from JD when authentic for that job's dates
4. Mechanism: HOW work was done (patterns, architecture, approach — 1 concrete detail)
5. Scale or complexity: users, requests, data volume, services, environments, teams, release frequency — when plausible
6. Outcome: business or engineering result (metric optional but outcome required)

LEVEL LANGUAGE (use what JD expects):
- JD wants senior/staff/lead -> bullets show ownership, design decisions, cross-team influence, standards, mentoring, end-to-end delivery
- JD wants mid -> bullets show independent feature/system delivery, production responsibility, collaboration
- JD wants exposure only -> still write confidently but scope smaller (supporting, contributing, implementing under lead)

WEAK BULLET PATTERNS (FORBIDDEN — these fail JD level):
- "Worked with React and Node.js on various projects."
- "Experience with AWS and Docker."
- "Familiar with CI/CD and agile methodologies."
- "Helped improve performance and code quality."
- "Used Kubernetes in the environment."
- One technology mentioned with no action, scope, or outcome

STRONG BULLET PATTERN (TARGET):
[Strong verb] + [specific system/scope] + [named tech + mechanism] + [scale/complexity] + [outcome]

Example (senior full stack): "Architected a React and Node.js order orchestration service with event-driven workers and Redis caching, sustaining 12k+ peak orders/hour while cutting p95 checkout latency materially for holiday traffic."

Example (senior QA): "Led Playwright and API contract test automation in GitLab CI with parallel sharding across 40+ microservices, blocking regressions pre-release and reducing production defect escape rate for payments flows."

CORE PRINCIPLE:
Experience must reflect: JD Tier-1 coverage, company scale, industry type, time period tech adoption, realistic seniority growth.

DETAIL-BASED BULLETS (CRITICAL):
1. Start from provided Details — For any job with "Details", derive bullets from those accomplishments; expand with JD-required depth and coverage where authentic.
2. JD-first for recent roles — Entry 1-2 bullets must explicitly prove Tier-1 requirements at the required level.
3. Maintain authenticity — Keep core accomplishments, seniority, and technologies from provided details; enhance framing and missing JD coverage, do not replace real work with fiction.
4. If no details provided — Generate plausible bullets from job title, company, dates, and JD; still satisfy Tier-1 coverage for entry 1-2.

Each bullet should be rich and between 25-30 words (longer if needed to prove level — never shorten into vague bullets).

STRUCTURE PER JOB (adapt to detected track — ensure Tier-1 areas each have at least one bullet in recent jobs):
- Default (product engineering): 1-2 system-level ownership + 2-3 delivery aligned to JD responsibilities + 2-3 optimization/integration/collaboration proving remaining Tier-1 skills
- QA/SDET: test strategy/automation + coverage across UI/API/performance/security as JD requires + CI quality gates + defect/release metrics
- DevOps/SRE: platform/CI/CD + IaC/observability + reliability/incident + scale/cost/security as JD requires
- Data: pipelines/warehouse + modeling/quality + analytics/SLAs + tooling JD names (Spark, dbt, Airflow, etc.)
- AI/ML: problem + model lifecycle + MLOps/evaluation + production impact for each JD ML requirement
- Salesforce: declarative + programmatic + integrations + release/adoption for each JD platform requirement

KEYWORD RULE (coverage-aware):
- Recent job bullets: explicitly name Tier-1 technologies and experience areas — natural prose, not comma lists
- Max 2-3 JD terms per bullet when needed to prove depth; avoid repeating the same term in consecutive bullets
- Older jobs: fewer explicit JD terms; show career progression toward Tier-1 skills

METRIC & IMPACT REALISM (CRITICAL):
- Do NOT put a precise KPI in every bullet. Real resumes mix impact types.
- Per job, aim for a natural blend:
  - ~50-60% bullets: clear metrics (%, scale, time, cost, users) when plausible
  - ~30-40% bullets: technical outcomes without exact numbers ("reduced query latency", "improved pipeline reliability", "faster dashboard load times")
  - ~20-30% bullets: qualitative or scope-based outcomes (cross-team delivery, production stability, maintainability, stakeholder usability)
- Avoid "100% KPI" resumes — that reads synthetic.
- Percentages must feel human, not lab-perfect:
  - FORBIDDEN pattern: many tidy round-ish values in one job (e.g., 28%, 35%, 42%, 48%, 62%)
  - Prefer varied forms: approximate language ("significantly", "materially"), ranges ("20-30%"), scale ("thousands of requests/day"), time saved, before/after without over-precision
  - Use exact % sparingly; max 2-3 precise percentage bullets per job, not every bullet
- Distribution guide when metrics ARE used:
  - 10-20% improvements -> common
  - 20-50% improvements -> standard
  - 50%+ improvements -> rare
  - 2x-3x -> max 3-4 per entire resume

**6. TECHNOLOGY REALISM RULE (STRICT)**

Only use technologies that:
- existed during job timeframe
- were realistically adopted in that company type

If uncertain -> use generic alternatives instead of specific frameworks.

Technology release examples (verify against job dates):
- Angular: 2016 | React: 2013 | TypeScript: 2012 | Vue.js: 2014 | Next.js: 2016
- Docker: 2013 | Kubernetes: 2014 | AWS Lambda: 2014 | GraphQL: 2015
- Pre-2013 frontend: jQuery, Backbone.js, AngularJS 1.x | Pre-2013 backend: PHP, Java, .NET, Ruby on Rails
${googleTechRealismSection}
**7. PAST EMPLOYER CONTEXT RULE (CRITICAL)**

"Company" here means each entry in the candidate WORK history — NOT the hiring employer from the JD.

Each past employer must influence bullet style:
- Enterprise (e.g., Nordstrom): governance, scale, compliance, reliability
- Mid-size SaaS: feature velocity, optimization, scaling
- Startup: ownership, rapid iteration, system building
- Early career roles: implementation, support, learning focus

**8. CAREER CONSISTENCY RULE**

Resume must represent ONE real human career.

**9. BULLET FORMAT**

Action Verb + Tech (valid for timeframe) + What + Impact (+ Metric ONLY when it sounds natural)

Template options (vary across bullets):
- With metric: [Verb] + [Tech] + [what you built/changed] + [measurable outcome when real]
- Without precise metric: [Verb] + [Tech] + [what you built/changed] + [technical or business outcome in plain language]

Good (natural — vary by track):
- Full stack/data: "Optimized PostgreSQL reporting queries to reduce latency and improve analytics responsiveness for operations teams."
- DevOps: "Hardened Kubernetes deployments with Helm and rolling updates, improving release success rate during high-traffic promotion windows."
- QA: "Built Playwright regression suites integrated into CI, catching critical checkout defects before production and stabilizing release cadence."
- Salesforce: "Delivered Apex and Flow automation for case routing, reducing manual triage time while keeping governor limits within safe thresholds."

Avoid (over-polished / synthetic):
- Forcing an exact % on every bullet
- Over-specific marketing-style KPIs on routine engineering work (e.g., "improving dashboard freshness for stakeholders by 45% during peak traffic windows" unless clearly supported by details)

Verbs: Architected, Engineered, Designed, Built, Developed, Implemented, Optimized, Enhanced, Led, Spearheaded, Automated, Deployed

Avoid: Responsible for, Worked on

**10. ATS + REALISM + JD COVERAGE CHECKLIST**

Before output:
- Resume is tailored to TARGET ROLE + JD technical requirements only (not generic full stack by default)
- No non-technical JD items reflected (remote/hybrid, languages, travel, contract terms, etc.)
- No hiring employer name or application-specific phrases anywhere in generated content
- Every Tier-1 JD must-have skill and experience area is demonstrated in recent roles (entry 1-2) at the required level
- No Tier-1 gap: if JD requires X, at least one bullet shows hands-on or ownership of X — not "exposure" wording unless JD is junior
- Each bullet is rich (28-35 words) with scope + action + tech + mechanism + outcome — no weak name-drop bullets
- Recent bullets match JD seniority (senior JD -> ownership/design/lead language, not helper-level phrasing)
- Resume reads like ONE consistent career for that track
- No keyword injection without context
- No unrealistic stack inflation
- Impact mix is realistic (not every bullet has a KPI; metrics are varied, imperfect, and believable)
- Company context is preserved
- Tech matches timeline realism
- Keywords are natural, not forced
- Balance exists between ATS depth and human readability — depth beats brevity for entry 1-2${googleChecklistItem}

**OUTPUT (STRICT)**

Return ONLY one valid JSON object (no markdown). Required shape:
{"title":"...","summary":"Sentence 1. Sentence 2. Sentence 3.","skills":{"Category":["Skill1","Skill2"]},"experience":[{"title":"...","details":["bullet1","bullet2"]}]}

JSON RULES:
- "summary" is a single string on one line (sentences separated by spaces only, no \\n or line breaks in the value)
- Escape any double quotes inside string values as \\"
- No trailing commas
`;

    const callOptions = { jsonMode: true };
    const { data: resumeData, response: aiResponse, text: rawAiText, error: parseError } =
      await generateResumeContent(prompt, callOptions);

    console.log("OpenAI API Response Metadata:");
    console.log("- Model:", aiResponse?.model);
    console.log("- Stop reason:", aiResponse?.stop_reason);
    console.log("- Input tokens:", aiResponse?.usage?.input_tokens);
    console.log("- Output tokens:", aiResponse?.usage?.output_tokens);

    if (aiResponse?.stop_reason === "length") {
      console.error("⚠️ WARNING: OpenAI hit the max_tokens limit! Response may be truncated.");
    }

    const rawContent = rawAiText || "";
    if (
      rawContent.toLowerCase().startsWith("i'm sorry") ||
      rawContent.toLowerCase().startsWith("i cannot") ||
      rawContent.toLowerCase().startsWith("i apologize")
    ) {
      console.error("AI is apologizing instead of returning JSON:", rawContent.substring(0, 200));
      throw new Error(
        "AI refused to generate resume. The prompt may be too complex. Please try again with a shorter job description or simpler requirements."
      );
    }

    if (!resumeData) {
      console.error("=== JSON PARSE ERROR ===");
      console.error("Error:", parseError);
      console.error("Content length:", rawContent.length);
      console.error("First 1000 chars:", rawContent.substring(0, 1000));
      console.error("Last 500 chars:", rawContent.substring(Math.max(0, rawContent.length - 500)));
      throw new Error("AI did not return valid JSON format. Please try again.");
    }

    let resumeContent = normalizeResumeContent(resumeData);
    
    // Validate required fields
    if (!resumeContent.title || !resumeContent.summary || !resumeContent.skills || !resumeContent.experience) {
      console.error("Missing required fields in AI response:", Object.keys(resumeContent));
      throw new Error("AI response missing required fields (title, summary, skills, or experience)");
    }

    console.log("✅ AI content generated successfully");
    console.log("Skills categories:", Object.keys(resumeContent.skills).length);
    console.log("Skills total:", countSkills(resumeContent.skills), `(cap ${SKILLS_HARD_CAP})`);
    console.log("Experience entries:", resumeContent.experience.length);
    
    // Debug: Check if experience has details
    resumeContent.experience.forEach((exp, idx) => {
      console.log(`Experience ${idx + 1}: ${exp.title || 'NO TITLE'} - Details count: ${exp.details?.length || 0}`);
      if (!exp.details || exp.details.length === 0) {
        console.error(`⚠️ WARNING: Experience entry ${idx + 1} has NO DETAILS!`);
      }
    });

    // Get cached template (compiled once per file, reused)
    const templateFn = getTemplate(profile);

    // Bold every Skills term where it appears in summary/experience — but only for
    // profiles whose template renders HTML. Others get plain text, unchanged.
    const boldEnabled = BOLD_KEYWORD_PROFILES.has(profile);
    const keywordRegex = boldEnabled ? buildKeywordRegex(resumeContent.skills) : null;
    const decorate = (text) => (boldEnabled ? boldKeywords(text, keywordRegex) : text);

    if (boldEnabled) {
      console.log("Keyword bolding: on,", countSkills(resumeContent.skills), "terms");
    }

    // Prepare data for template
    const templateData = {
      name: profileData.name,
      title: resumeContent.title,
      email: profileData.email,
      phone: profileData.phone,
      location: profileData.location,
      linkedin: profileData.linkedin,
      website: profileData.website,
      summary: decorate(resumeContent.summary),
      skills: resumeContent.skills,
      experience: profileData.experience.map((job, idx) => ({
        title: job.title || resumeContent.experience[idx]?.title || "Engineer",
        company: job.company,
        location: job.location,
        start_date: job.start_date,
        end_date: job.end_date,
        details: (resumeContent.experience[idx]?.details || []).map(decorate)
      })),
      education: profileData.education
    };

    // Render HTML
    const html = templateFn(templateData);
    console.log("HTML rendered from template");

    // Generate PDF with Puppeteer (optimized)
    // Check if running on Vercel (serverless environment)
    const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
    const isProduction = process.env.NODE_ENV === 'production';
    const isServerless = isVercel || isProduction;
    
    let browser;
    if (isServerless) {
      // Optimized chromium args for faster startup in serverless
      const optimizedArgs = [
        ...chromium.args,
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ];
      
      browser = await puppeteerCore.launch({
        args: optimizedArgs,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
    } else {
      // Local dev: use your system Chrome/Chromium.
      // Set PUPPETEER_EXECUTABLE_PATH to your Chrome path if launch fails.
      const localExecutablePath = getLocalChromeExecutablePath();

      const launchOptions = {
        headless: "new",
        args: [
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-sandbox'
        ]
      };

      if (localExecutablePath) {
        launchOptions.executablePath = localExecutablePath;
      } else {
        // puppeteer-core requires either executablePath or channel
        // This works when Chrome is installed and discoverable by Puppeteer.
        launchOptions.channel = "chrome";
      }

      browser = await puppeteerCore.launch(launchOptions);
    }

    const page = await browser.newPage();
    // Use 'load' instead of 'networkidle0' - much faster since we have no external resources
    await page.setContent(html, { waitUntil: "load" });
    
    // Generate PDF with optimized settings
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { 
        top: "15mm", 
        bottom: "7mm", 
        left: "0mm", 
        right: "0mm" 
      },
      preferCSSPageSize: false, // Faster rendering
    });
    
    await browser.close();

    console.log("PDF generated successfully!");
    
    // No Content-Disposition here on purpose. The client downloads through a blob: URL
    // (pages/index.js), and blob URLs discard response headers — only a.download names
    // the file. A filename set here would be silently ignored while looking authoritative.
    res.setHeader("Content-Type", "application/pdf");
    res.end(pdfBuffer);
    

  } catch (err) {
    console.error("PDF generation error:", err);

    const status = err?.status;
    const apiMessage = err?.error?.error?.message || err?.error?.message;

    if (status === 403) {
      return res
        .status(500)
        .send(
          "PDF generation failed: OpenAI returned 403 Forbidden (Request not allowed). " +
            "Check that OPENAI_API_KEY is set correctly for this environment and that your OpenAI account/key has access to the configured model. " +
            (apiMessage ? `Details: ${apiMessage}` : "")
        );
    }

    res.status(500).send("PDF generation failed: " + (apiMessage || err.message));
  }
}
