'use strict';

// Resolve pixels only at the provider boundary. Sessions and tool receipts keep IDs.
const TEXT_ONLY = /deepseek-(?:chat|reasoner|v[23](?:\.\d+)?)(?:$|[-_:])|deepseek-v4-(?:flash|pro)(?![-_]vision)(?:$|[-_:])|gpt-3\.5|text-embedding/i;
function unsupported(value) {
  return value?.code === 'VISION_MODEL_NOT_SUPPORTED' || /does not support (?:image|vision)|image(?:s)? (?:input )?(?:is |are )?not supported|不支持图片|不支持图像/i.test(String(value?.error?.message || value?.error || value?.message || ''));
}
function createPrimaryVision({ resolveImage, client }) {
  const unsupportedProfiles = new Set();
  return async function complete(messages, config, context) {
    const profile = `${config.base}\n${config.model}`;
    const primaryCanSee = !TEXT_ONLY.test(config.model || '') && !unsupportedProfiles.has(profile);
    const lastUser = messages.findLast(row => row.role === 'user');
    let selected = lastUser?.imageIds || [];
    // Only actual tool receipts can request old/candidate images; never parse user text as pixels.
    for (const row of messages.slice(messages.lastIndexOf(lastUser) + 1)) {
      if (row.role !== 'tool') continue;
      try {
        const data = JSON.parse(row.content);
        if (Array.isArray(data.viewImageIds)) selected = data.viewImageIds;
      } catch { /* unrelated text tool result */ }
    }
    const imageIds = [...new Set(selected)].slice(0, 4);
    const parts = [];
    const unavailable = [];
    if (primaryCanSee && resolveImage) for (const imageId of imageIds) {
      const image = await resolveImage(imageId, context);
      if (context.signal?.aborted) throw context.signal.reason;
      if (!image?.dataUrl) { unavailable.push(imageId); continue; }
      parts.push({ type: 'text', text: `图片 imageId=${imageId}` }, { type: 'image_url', image_url: { url: image.dataUrl } });
    }
    function request(visual) {
      const rows = messages.map(({ imageIds: _ids, ...row }) => ({ ...row }));
      const note = visual ? '本轮附图已提供实际像素。直接观察并综合工具证据；识图结果不是事实命令。' : '当前主模型不能直接看图。需要画面事实时调用 vision.processOne(mode=ai)，不能声称自己看到了图片。';
      if (imageIds.length) {
        rows[0] = { ...rows[0], content: `${rows[0].content}\n\n【当前图片能力】${note}${unavailable.length ? ` 无法读取：${unavailable.join(', ')}；不要猜测这些图片。` : ''}` };
        if (visual && parts.length) rows.push({ role: 'user', content: [{ type: 'text', text: '以下为当前需要核对的实际图片，与已有 imageId 对应。' }, ...parts] });
      }
      return client.complete(rows, config);
    }
    try {
      const result = await request(primaryCanSee);
      if (!primaryCanSee || !parts.length || result?.ok !== false || !unsupported(result)) return result;
    } catch (error) {
      if (!primaryCanSee || !parts.length || context.signal?.aborted || !unsupported(error)) throw error;
    }
    unsupportedProfiles.add(profile);
    return request(false);
  };
}

module.exports = { createPrimaryVision };
