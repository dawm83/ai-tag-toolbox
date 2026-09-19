'use strict';

const DEFAULT_CATEGORIES = [
  { id: 'quality', name: '质量词', icon: '⭐' },
  { id: 'negative', name: '负面提示词', icon: '🚫', neg: true },
  { id: 'character', name: '人物与角色', icon: '👥' },
  { id: 'series', name: '作品系列', icon: '📺' },
  { id: 'body', name: '身材与身体', icon: '🧍' },
  { id: 'expression', name: '表情', icon: '😊' },
  { id: 'eyes', name: '眼睛', icon: '👁️' },
  { id: 'hair', name: '头发', icon: '💇' },
  { id: 'features', name: '角色特征', icon: '🦊' },
  { id: 'outfit', name: '服装', icon: '👗' },
  { id: 'footwear', name: '鞋袜', icon: '🧦' },
  { id: 'accessory', name: '道具与装饰', icon: '🎀' },
  { id: 'pose', name: '动作与姿势', icon: '🤸' },
  { id: 'scene', name: '场景与环境', icon: '🏞️' },
  { id: 'camera', name: '视角与镜头', icon: '🎥' },
  { id: 'style', name: '画风与风格', icon: '🖌️' },
  { id: 'time_weather', name: '时间与天气', icon: '🌤️' },
  { id: 'atmosphere', name: '氛围与光影', icon: '✨' },
  { id: 'effects', name: '特效与魔法', icon: '🔥' },
  { id: 'food', name: '食物与饮料', icon: '🍰' },
  { id: 'animal', name: '动物', icon: '🐾' },
  { id: 'other', name: '其他', icon: '🏷️' },
  { id: 'rating', name: '内容分级', icon: '🅰️' },
  { id: 'nsfw', name: '成人标签', icon: '🔞', nsfw: true },
  { id: 'character_names', name: '角色名', icon: '🏷️' }
];
const PALETTE = Object.freeze(['#287EA4', '#C75450', '#5A8F50', '#B67823', '#7256A8', '#00897B', '#B04A7A', '#65737E', '#8B6F47', '#446CB3']);
module.exports = { DEFAULT_CATEGORIES, PALETTE };
