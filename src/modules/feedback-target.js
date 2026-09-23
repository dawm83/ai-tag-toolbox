'use strict';

const rows = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.trim() : '';

function candidateOptions(targets, references) {
  const refs = new Map(rows(references).map(ref => [ref.imageId, ref]));
  return targets.flatMap(({ job, messageId }) => rows(job.candidates).map((candidate, index) => ({
    jobId: job.jobId, messageId, candidateId: candidate.id, imageId: candidate.imageId,
    slotNo: Number(refs.get(candidate.imageId)?.slotNo) || Number(candidate.artifact?.slotNo) || 0,
    iteration: Number(candidate.iteration) || index + 1,
    roundIndex: Number(candidate.roundIndex) || 1,
    selected: candidate.id === job.selectedCandidateId || candidate.selected === true,
    summary: text(candidate.primaryReview?.summary || candidate.evaluation?.summary).slice(0, 240),
    issues: rows(candidate.primaryReview?.issues || candidate.evaluation?.issues).slice(0, 3).map(issue => ({
      observed: text(issue.observed).slice(0, 240), suggestedChange: text(issue.suggestedChange).slice(0, 240)
    }))
  }))).filter(option => option.imageId && option.candidateId);
}

function resolveFeedbackTarget(input, options, latestJobId) {
  const value = text(input.text).normalize('NFKC').replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, ' ');
  const groups = [];
  const add = predicate => groups.push(options.filter(predicate));
  for (const match of value.matchAll(/(?:图片?|image)\s*#?\s*(\d+)|第\s*(\d+)\s*(?:张|幅)/gi)) {
    const slot = Number(match[1] || match[2]);
    add(option => option.slotNo === slot);
  }
  for (const match of value.matchAll(/\b(?:candidate[-_]\d+|(?:img_|image-)[a-zA-Z0-9_-]+)\b/g)) {
    add(option => option.candidateId === match[0] || option.imageId === match[0]);
  }
  const latest = options.filter(option => option.jobId === latestJobId);
  for (const match of value.matchAll(/第\s*(\d+)\s*轮/g)) {
    groups.push(latest.filter(option => option.roundIndex === Number(match[1])));
  }
  if (groups.length) {
    const matches = [...new Map(groups.flat().map(option => [option.imageId, option])).values()];
    return groups.every(group => group.length) && matches.length === 1
      ? { option: matches[0] } : { options: matches.length > 1 ? matches : options };
  }
  const attached = rows(input.imageIds);
  if (attached.length) {
    const matches = options.filter(option => attached.includes(option.imageId));
    return attached.length === 1 && matches.length === 1 ? { option: matches[0] } : { options: matches.length ? matches : options };
  }
  if (/最后一张|最新(?:的)?(?:一张|图片?)|刚才(?:的)?(?:那张|一张)|上一张|\b(?:last|latest|previous) (?:image|picture)\b/i.test(value)) {
    return latest.length ? { option: latest.at(-1) } : { options };
  }
  if (/上一轮/.test(value)) {
    const matches = latest.filter(option => option.roundIndex === latest.at(-1)?.roundIndex);
    return matches.length === 1 ? { option: matches[0] } : { options: matches };
  }
  if (/选中|选择的|推荐的|\bselected\b/i.test(value)) {
    const matches = latest.filter(option => option.selected);
    return matches.length === 1 ? { option: matches[0] } : { options: latest };
  }
  return latest.length === 1 ? { option: latest[0] } : { options: latest.length ? latest : options };
}

module.exports = { candidateOptions, resolveFeedbackTarget };
