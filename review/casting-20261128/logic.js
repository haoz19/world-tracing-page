'use strict';
(function(root) {
  const DATASET = 'wt-casting-20261128-v1';
  const PAGE_SIZE = 2, NOTE_LIMIT = 240, MAX_PAYLOAD = 64000;
  const PHOTO_IDS = ['black_minimal_cast_v1','color_editorial_cast_v1','lemon_resort','slate_sculpted','ivory_stage','pearl_drape'];
  const ANIME_IDS = ['anime_cyber_cel','anime_pastel_shoujo','anime_ink_manga','anime_painterly_fantasy','anime_watercolor_muse','anime_retro_pop'];
  const IDS = [...PHOTO_IDS,...ANIME_IDS];
  const FILTERS = ['all','photo','anime'];
  const RATINGS = [['like','喜欢'],['revise','待改']];
  const TAGS = [['face','脸'],['body','身材'],['outfit','服装'],['style','风格']];
  const STORE = 'wt-casting:' + DATASET + ':feedback:v1';
  function exact(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value,k));
  }
  function validateManifest(data) {
    if (!data || data.schema_version !== 1 || data.dataset_id !== DATASET ||
        !Array.isArray(data.images) || data.images.length !== IDS.length) throw Error('Wrong casting manifest');
    const seen = new Set(), hashes = new Set();
    for (const item of data.images) {
      if (!item || !IDS.includes(item.id) || seen.has(item.id) ||
          item.kind !== (PHOTO_IDS.includes(item.id) ? 'photo' : 'anime') ||
          typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100 ||
          item.image !== 'assets/' + item.id + '.png' ||
          typeof item.image_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.image_sha256) ||
          hashes.has(item.image_sha256) ||
          !Number.isInteger(item.width) || item.width < 1 || item.width > 16384 ||
          !Number.isInteger(item.height) || item.height < 1 || item.height > 16384 ||
          (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 400)) ||
          (item.bytes !== undefined && (!Number.isSafeInteger(item.bytes) || item.bytes < 1))) throw Error('Wrong image, category, hash or dimensions');
      seen.add(item.id); hashes.add(item.image_sha256);
    }
    // Stable display order does not depend on asynchronous image completion.
    return {...data, images: IDS.map(id => data.images.find(item => item.id === id))};
  }
  function filterItems(manifest, filter) {
    return manifest.images.filter(item => filter === 'all' || item.kind === filter);
  }
  function validateFeedback(data, manifest) {
    if (!exact(data,['schema_version','dataset_id','filter','page','feedback']) ||
        data.schema_version !== 1 || data.dataset_id !== DATASET || !FILTERS.includes(data.filter) ||
        !Number.isInteger(data.page) || data.page < 0 ||
        data.page >= Math.ceil(filterItems(manifest,data.filter).length / PAGE_SIZE) ||
        !Array.isArray(data.feedback) || data.feedback.length > IDS.length) throw Error('Wrong feedback envelope');
    const items = new Map(manifest.images.map(item => [item.id,item]));
    const checked = new Map();
    for (const value of data.feedback) {
      if (!exact(value,['id','image_sha256','rating','tags','note']) ||
          !items.has(value.id) || checked.has(value.id) ||
          value.image_sha256 !== items.get(value.id).image_sha256 ||
          !['',...RATINGS.map(r => r[0])].includes(value.rating) ||
          !Array.isArray(value.tags) || value.tags.length > TAGS.length ||
          new Set(value.tags).size !== value.tags.length ||
          !value.tags.every(tag => TAGS.some(t => t[0] === tag)) ||
          typeof value.note !== 'string' || value.note.length > NOTE_LIMIT ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.note)) throw Error('Wrong image version or feedback');
      checked.set(value.id,{id:value.id,image_sha256:value.image_sha256,rating:value.rating,tags:[...value.tags],note:value.note});
    }
    return {entries:checked,page:data.page,filter:data.filter};
  }
  function encodeFeedback(data) {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    let text = ''; for (const b of bytes) text += String.fromCharCode(b);
    const result = btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
    if (result.length > MAX_PAYLOAD) throw Error('Feedback too large');
    return result;
  }
  function decodeFeedback(encoded) {
    if (!encoded || encoded.length > MAX_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw Error('Invalid feedback encoding');
    const s = encoded.replace(/-/g,'+').replace(/_/g,'/');
    const raw = atob(s + '='.repeat((4-s.length%4)%4));
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(raw,c => c.charCodeAt(0))));
  }
  const api = Object.freeze({DATASET,PAGE_SIZE,NOTE_LIMIT,MAX_PAYLOAD,IDS:Object.freeze(IDS),PHOTO_IDS:Object.freeze(PHOTO_IDS),ANIME_IDS:Object.freeze(ANIME_IDS),FILTERS:Object.freeze(FILTERS),RATINGS,TAGS,STORE,validateManifest,validateFeedback,filterItems,encodeFeedback,decodeFeedback});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WTCasting = api;
})(typeof window !== 'undefined' ? window : globalThis);
