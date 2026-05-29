import { extractKeywordLabels, normalizeToken, unique } from "./textUtils.js";
import { HARD_SKILLS } from "./taxonomy.js";

const DEFAULT_MODEL = process.env.SEMANTIC_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const DEFAULT_THRESHOLD = Number(process.env.SEMANTIC_MATCH_THRESHOLD || 0.66);
const DEFAULT_TIMEOUT_MS = Number(process.env.SEMANTIC_MATCH_TIMEOUT_MS || 20000);
const EMBEDDING_CACHE_LIMIT = Number(process.env.SEMANTIC_EMBEDDING_CACHE_LIMIT || 600);
const TEXT_LIMIT = 8000;

let extractorPromise = null;
const embeddingCache = new Map();

export async function buildSemanticMatchSignals(resume, job, options = {}) {
  if (!isSemanticEnabled(options)) return null;

  try {
    return await withTimeout(buildSemanticMatchSignalsInner(resume, job, options), Number(options.semanticTimeoutMs || DEFAULT_TIMEOUT_MS));
  } catch (error) {
    return {
      model: DEFAULT_MODEL,
      error: error.message,
      hard: null,
      soft: null,
      project: null,
    };
  }
}

async function buildSemanticMatchSignalsInner(resume, job, options = {}) {
    const hard = await semanticCoverage(resume.skills || [], job.hard_skills || [], {
      label: "hard_skill",
      threshold: options.semanticThreshold,
      resumeText: resume.raw_text,
      jobText: job.jd_raw_text,
    });

    const soft = await semanticCoverage(resume.soft_skills || [], job.soft_skills || [], {
      label: "soft_skill",
      threshold: options.semanticThreshold,
      resumeText: resume.raw_text,
      jobText: job.jd_raw_text,
    });

    const projectSkills = extractKeywordLabels(
      (resume.projects || [])
        .map((project) => [project.name, project.raw, ...(project.technologies || []), ...(project.contribution || [])].join(" "))
        .join("\n"),
      HARD_SKILLS,
    );
    const project = await semanticCoverage(projectSkills, job.hard_skills || [], {
      label: "project",
      threshold: options.semanticThreshold,
      resumeText: (resume.projects || []).map((project) => project.raw || project.name || "").join("\n"),
      jobText: job.jd_raw_text,
    });

    return {
      model: DEFAULT_MODEL,
      blend: { keyword: 0.4, semantic: 0.6 },
      hard,
      soft,
      project,
    };
}

export function blendKeywordAndSemanticCoverage(keywordCoverage, semanticCoverage, options = {}) {
  if (!semanticCoverage || !Number.isFinite(semanticCoverage.score)) return keywordCoverage;
  const keywordWeight = Number(options.keywordWeight ?? 0.4);
  const semanticWeight = Number(options.semanticWeight ?? 0.6);
  const totalWeight = keywordWeight + semanticWeight || 1;
  const score = (keywordCoverage.score * keywordWeight + semanticCoverage.score * semanticWeight) / totalWeight;
  const exactHits = keywordCoverage.hits || [];
  const semanticHits = (semanticCoverage.hits || []).filter((item) => !exactHits.some((hit) => normalizeToken(hit) === normalizeToken(item)));

  return {
    ...keywordCoverage,
    score,
    hits: unique([...exactHits, ...semanticHits]),
    missing: semanticCoverage.missing || keywordCoverage.missing || [],
    semantic_score: Math.round(semanticCoverage.score),
    semantic_hits: semanticHits,
    note: semanticCoverage.note || keywordCoverage.note || "",
  };
}

export async function semanticCoverage(available, required, options = {}) {
  const requiredClean = unique(required);
  const availableClean = unique(available);
  if (!requiredClean.length) return { score: 100, hits: [], missing: [], note: "" };

  const availableTexts = unique([
    ...availableClean,
    ...compactSemanticText(options.resumeText ? [options.resumeText] : []),
  ]).slice(0, 24);
  if (!availableTexts.length) {
    return {
      score: 0,
      hits: [],
      missing: requiredClean,
      note: "No resume-side text was available for semantic matching.",
    };
  }

  const threshold = Number(options.threshold || DEFAULT_THRESHOLD);
  const availableVectors = await Promise.all(availableTexts.map(embedText));
  const requiredVectors = await Promise.all(requiredClean.map(embedText));
  const matches = requiredClean.map((item, index) => {
    const best = bestMatch(requiredVectors[index], availableVectors, availableTexts);
    return {
      required: item,
      matched: best.text,
      similarity: best.similarity,
      score: similarityToScore(best.similarity),
      isHit: best.similarity >= threshold,
    };
  });

  const hits = matches.filter((item) => item.isHit).map((item) => item.required);
  return {
    score: matches.reduce((sum, item) => sum + item.score, 0) / matches.length,
    hits,
    missing: matches.filter((item) => !item.isHit).map((item) => item.required),
    matches,
    note: `Semantic ${options.label || "coverage"} via ${DEFAULT_MODEL}.`,
  };
}

function isSemanticEnabled(options) {
  if (options.semantic === false) return false;
  return String(process.env.SEMANTIC_MATCH_ENABLED || "true").toLowerCase() !== "false";
}

async function embedText(value) {
  const text = normalizeEmbeddingText(value);
  if (!text) return [];
  if (embeddingCache.has(text)) return embeddingCache.get(text);

  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  const vector = Array.from(output.data || output.tolist?.()[0] || []);
  rememberEmbedding(text, vector);
  return vector;
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import("@xenova/transformers").then(({ pipeline, env }) => {
      env.allowLocalModels = false;
      return pipeline("feature-extraction", DEFAULT_MODEL);
    });
  }
  return extractorPromise;
}

function rememberEmbedding(text, vector) {
  if (embeddingCache.size >= EMBEDDING_CACHE_LIMIT) {
    const firstKey = embeddingCache.keys().next().value;
    embeddingCache.delete(firstKey);
  }
  embeddingCache.set(text, vector);
}

function bestMatch(requiredVector, availableVectors, availableTexts) {
  let best = { text: "", similarity: 0 };
  availableVectors.forEach((vector, index) => {
    const similarity = cosine(requiredVector, vector);
    if (similarity > best.similarity) best = { text: availableTexts[index], similarity };
  });
  return best;
}

function cosine(left, right) {
  if (!left?.length || !right?.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function similarityToScore(similarity) {
  const score = ((Number(similarity) || 0) - 0.35) / 0.5;
  return Math.max(0, Math.min(100, score * 100));
}

function compactSemanticText(values) {
  return values
    .map((value) => String(value || "").slice(0, TEXT_LIMIT))
    .filter(Boolean);
}

function normalizeEmbeddingText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_LIMIT);
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Semantic matching timed out after ${timeoutMs}ms.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
