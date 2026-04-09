// 确定性种子抽样：用 sha256(seedString) 作为种子从数组里挑 N 条索引
// 同一 (length, seedString) 输入永远产生相同输出，便于事后追溯审计

const crypto = require('crypto');

// Mulberry32 PRNG — 简单、确定、纯函数
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(s) {
  return crypto.createHash('sha256').update(String(s)).digest().readUInt32BE(0);
}

// 从 [0..length-1] 中确定性挑出 n 条索引（已排序，便于阅读）
// n >= length 时返回全部
function sampleIndices(length, n, seedString) {
  if (length <= 0 || n <= 0) return [];
  if (n >= length) return [...Array(length).keys()];

  const rng = mulberry32(seedFromString(seedString));
  const indices = [...Array(length).keys()];
  // Fisher-Yates 部分洗牌：只洗前 n 位
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (length - i));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, n).sort((a, b) => a - b);
}

// 默认抽样数：N = max(1, ceil(length / 3))
function defaultSampleCount(length) {
  return Math.max(1, Math.ceil(length / 3));
}

// 业务封装：从 verifier evidence 数组挑出抽样后的对象列表
// 输入: evidenceArray: string[]  seedString: 一般传 section.header
// 输出: [{index: 2, text: "..."}, ...]
function sampleEvidenceIndices(evidenceArray, seedString) {
  const arr = Array.isArray(evidenceArray) ? evidenceArray : [];
  const n = defaultSampleCount(arr.length);
  const idx = sampleIndices(arr.length, n, seedString);
  return idx.map(i => ({ index: i, text: arr[i] }));
}

module.exports = {
  mulberry32,
  seedFromString,
  sampleIndices,
  defaultSampleCount,
  sampleEvidenceIndices,
};
