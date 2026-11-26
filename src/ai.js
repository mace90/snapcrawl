import fs from 'node:fs';
import path from 'node:path';

// Optional. Bring your own key: Anthropic, OpenAI or a local Ollama model.
// The algorithm decides what changed; the model only describes it and suggests a verdict.

const PROMPT = `You review a visual regression in a mobile app.
Image 1 is the baseline screenshot, image 2 is the new build.
Answer with JSON only: {"verdict":"intended"|"bug"|"unclear","summary":"<one sentence, max 25 words>"}.
"intended" = deliberate design change; "bug" = broken layout, clipped or overlapping text, missing content, error state.`;

const PROMPT_SINGLE = (status) => `You review a screen of a mobile app that is ${status === 'new' ? 'new in this build (no baseline exists)' : 'reported as broken'}.
Answer with JSON only: {"verdict":"intended"|"bug"|"unclear","summary":"<one sentence, max 25 words>"}.`;

const b64 = (file) => fs.readFileSync(file).toString('base64');

async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function ask(ai, prompt, images) {
  if (ai.provider === 'anthropic') {
    const r = await post(ai.baseUrl || 'https://api.anthropic.com/v1/messages', { 'x-api-key': ai.apiKey, 'anthropic-version': '2023-06-01' }, {
      model: ai.model,
      max_tokens: 300,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }))] }],
    });
    return r.content?.map((c) => c.text || '').join('') || '';
  }
  if (ai.provider === 'openai') {
    const r = await post(ai.baseUrl || 'https://api.openai.com/v1/chat/completions', { authorization: `Bearer ${ai.apiKey}` }, {
      model: ai.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map((data) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }))] }],
    });
    return r.choices?.[0]?.message?.content || '';
  }
  if (ai.provider === 'ollama') {
    const r = await post(ai.baseUrl || 'http://localhost:11434/api/chat', {}, { model: ai.model, stream: false, messages: [{ role: 'user', content: prompt, images }] });
    return r.message?.content || '';
  }
  throw new Error(`Unknown AI provider "${ai.provider}"`);
}

function parse(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m ? m[0] : text);
    return { verdict: ['intended', 'bug', 'unclear'].includes(j.verdict) ? j.verdict : 'unclear', summary: String(j.summary || '').slice(0, 240) };
  } catch {
    return { verdict: 'unclear', summary: String(text).trim().slice(0, 240) };
  }
}

export function aiReady(ai) {
  if (!ai || ai.provider === 'none' || !ai.provider) return false;
  return ai.provider === 'ollama' || !!ai.apiKey;
}

export async function annotate({ store, report, cfg, onProgress = () => {} }) {
  const ai = cfg.ai;
  if (!aiReady(ai)) throw new Error('No AI provider configured. Run: snapcrawl config set ai.provider anthropic (and set ANTHROPIC_API_KEY)');
  const todo = report.screens.filter((s) => s.status !== 'same' && s.status !== 'skipped' && !report.notes[s.id] && (s.headImg || s.baseImg));
  let done = 0;
  for (const s of todo) {
    const file = (rel) => path.join(store.root, rel);
    try {
      const text = s.status === 'changed' && s.baseImg && s.headImg
        ? await ask(ai, PROMPT, [b64(file(s.baseImg)), b64(file(s.headImg))])
        : await ask(ai, PROMPT_SINGLE(s.status), [b64(file(s.headImg || s.baseImg))]);
      report.notes[s.id] = { ...parse(text), model: `${ai.provider}/${ai.model}` };
    } catch (e) {
      report.notes[s.id] = { verdict: 'unclear', summary: `Request failed: ${e.message}`, model: `${ai.provider}/${ai.model}` };
    }
    onProgress(++done, todo.length, s);
  }
  store.writeReport(report);
  return report;
}
