// Device-local visual preferences. Only a catalog ID is stored; never persona or chat data.
export const CHARACTER_PORTRAITS = Object.freeze([
  { id: 'original', label: '经典形象', group: '经典', src: '/assets/qiyu-character.png' },
  { id: 'male-01', label: '温柔书卷', group: '男性', src: '/assets/portraits/male-01.png' },
  { id: 'male-02', label: '沉静知性', group: '男性', src: '/assets/portraits/male-02.png' },
  { id: 'male-03', label: '晴朗随性', group: '男性', src: '/assets/portraits/male-03.png' },
  { id: 'female-01', label: '温暖文艺', group: '女性', src: '/assets/portraits/female-01.png' },
  { id: 'female-02', label: '从容独立', group: '女性', src: '/assets/portraits/female-02.png' },
  { id: 'female-03', label: '清新明亮', group: '女性', src: '/assets/portraits/female-03.png' }
]);

export function portraitById(id) {
  return CHARACTER_PORTRAITS.find((portrait) => portrait.id === id) ?? CHARACTER_PORTRAITS[0];
}

export function loadPortraitId(characterId, storage) {
  if (!characterId) return 'original';
  try { return portraitById(storage.getItem(`qiyu-portrait-v1:${characterId}`)).id; }
  catch { return 'original'; }
}

export function savePortraitId(characterId, id, storage) {
  if (!characterId || !CHARACTER_PORTRAITS.some((portrait) => portrait.id === id)) return false;
  try { storage.setItem(`qiyu-portrait-v1:${characterId}`, id); return true; }
  catch { return false; }
}
