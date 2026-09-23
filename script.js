/* ---------------- Supabase config ----------------
   Fill these in from your Supabase project: Settings > API.
   SUPABASE_URL looks like https://xxxxx.supabase.co
   SUPABASE_ANON_KEY is the long "anon public" key (safe to expose in client code).
--------------------------------------------------- */
const SUPABASE_URL = 'https://zjnxhdnlvjezafvzdpop.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_wxWfOqUPgq5mFUNuYxZudA_CviZzdrE';

const CONFIGURED = SUPABASE_URL.startsWith('http') && SUPABASE_ANON_KEY.length > 20;
const supabaseClient = CONFIGURED ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Edge Function that does the AI autofill (fetches the URL + calls Gemini
// server-side). Deployed separately in the Supabase dashboard — see
// supabase-function-autofill-resource.ts.
// Edge Function that does the AI autofill (fetches the URL + calls Gemini
// server-side). Deployed separately in the Supabase dashboard — see
// supabase-function-autofill-resource.ts. Note: this calls the function's
// actual URL slug, which Supabase can generate differently from the display
// name shown in the dashboard (ours is named "autofill-resource" but its
// real URL path is "bright-task" — check your own function's URL column
// under Edge Functions if you ever redeploy it under a new project).
const AUTOFILL_URL = CONFIGURED ? `${SUPABASE_URL}/functions/v1/bright-task` : null;

const DEFAULT_SETTINGS = {
  title: "The student-powered guide to Harvey Mudd, bringing campus resources, opportunities, organizations, events, and all the little things you shouldn't have to hunt for into one place.",

};

const SEED_RESOURCES = [
  {
    id: 'r1',
    title: 'Makerspace Sign-In Portal',
    description: 'The makerspace booking and check-in system. You need a school account to sign in — this is where you reserve time on the laser cutter and 3D printers.',
    url: 'https://example.com/makerspace-signin',
    type: 'link',
    category: 'Makerspace',
    tags: ['Sign-in required', 'Booking', 'Fabrication'],
    addedAt: Date.now() - 86400000*10
  },
  {
    id: 'r2',
    title: '3D Printing Starter Guide',
    description: 'A short PDF walking through slicer settings, bed leveling, and common first-print mistakes.',
    url: 'https://example.com/3d-printing-guide.pdf',
    type: 'file',
    category: 'Makerspace',
    tags: ['3D printing', 'Guide'],
    addedAt: Date.now() - 86400000*6
  },
  {
    id: 'r3',
    title: 'Open Build Nights',
    description: 'Drop-in hours every Thursday 6–9pm. No booking needed, just show up. Staff on hand to help with whatever you\'re working on.',
    url: '',
    type: 'info',
    category: 'Events',
    tags: ['Event', 'Weekly', 'Drop-in'],
    addedAt: Date.now() - 86400000*2
  },
  {
    id: 'r4',
    title: 'Peer Tutoring Sign-Up',
    description: 'Free drop-in and scheduled tutoring across most intro courses. Sign up for a slot or check who\'s available right now.',
    url: 'https://example.com/tutoring-signup',
    type: 'link',
    category: 'Tutoring',
    tags: ['Sign-in required', 'Academic support'],
    addedAt: Date.now() - 86400000*4
  },
  {
    id: 'r5',
    title: 'Dining Hall Menus & Hours',
    description: 'Daily menus, allergen info, and hours for all campus dining locations.',
    url: 'https://example.com/dining',
    type: 'link',
    category: 'Dining',
    tags: ['Menus', 'Hours'],
    addedAt: Date.now() - 86400000*1
  }
];

/* ---------------- State ---------------- */
let resources = [];
let settings = { ...DEFAULT_SETTINGS };
let isAdmin = false;
let activeTag = null;
let activeType = null;
let searchQuery = '';
let editingId = null;
let categories = [];
let tidbits = [];
let tidbitTopics = [];
let tidbitGroups = [];       // top-level sections that topics are organized into (e.g. Clubs, Academics, Dining)
let topicGroups = {};        // map: topic name -> group name (topics with no entry show under "Ungrouped")
let activeTopicFilter = null;    // when set (from the sidebar Topics list), Field Notes shows only this topic
let sidebarSection = 'resources'; // 'resources' | 'tidbits' — which sidebar panel is showing, driven by scroll position

// Which feed category sections are collapsed — persisted in localStorage
// (a per-browser display preference, not shared data) so it survives reloads.
let collapsedCategories = new Set();
try{
  collapsedCategories = new Set(JSON.parse(localStorage.getItem('wallyCollapsedCategories') || '[]'));
}catch(e){ collapsedCategories = new Set(); }
function saveCollapsedCategories(){
  try{ localStorage.setItem('wallyCollapsedCategories', JSON.stringify([...collapsedCategories])); }catch(e){ /* ignore (private browsing, etc.) */ }
}

// Same pattern, but for Field Notes group sections (Tips feed).
let collapsedGroups = new Set();
try{
  collapsedGroups = new Set(JSON.parse(localStorage.getItem('wallyCollapsedGroups') || '[]'));
}catch(e){ collapsedGroups = new Set(); }
function saveCollapsedGroups(){
  try{ localStorage.setItem('wallyCollapsedGroups', JSON.stringify([...collapsedGroups])); }catch(e){ /* ignore (private browsing, etc.) */ }
}

/* ---------------- Data access (Supabase, with local fallback) ----------------
   Only the columns the UI actually reads are requested. Naming them keeps a
   column added to a table later from silently growing the payload the browser
   has to download for every visitor. */
const RESOURCE_COLUMNS = 'id, title, description, type, url, category, tags, source_text, icon_url, app_store_url, screenshots, added_at';
const TIDBIT_COLUMNS = 'id, resource_id, topic, text, position';
const SETTINGS_COLUMNS = 'title, subtitle, categories, tidbit_topics, tidbit_groups, topic_groups';
const RESOURCE_PAGE_SIZE = 6;

function mapResourceRow(r){
  return {
    id: r.id,
    title: r.title,
    description: r.description || '',
    type: r.type,
    url: r.url || '',
    category: r.category || 'Uncategorized',
    tags: r.tags || [],
    sourceText: r.source_text || '',
    iconUrl: r.icon_url || '',
    appStoreUrl: r.app_store_url || '',
    screenshots: r.screenshots || [],
    addedAt: new Date(r.added_at).getTime()
  };
}

async function loadResourcePage(from, to){
  if(!CONFIGURED) return SEED_RESOURCES.slice(from, to + 1);
  const { data, error } = await supabaseClient
    .from('resources')
    .select(RESOURCE_COLUMNS)
    .order('added_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to);
  if(error){
    console.error(error);
    showToast('Could not load more resources.');
    return null;
  }
  return data.map(mapResourceRow);
}

async function loadResources(){
  if(!CONFIGURED) return SEED_RESOURCES;
  const { data, error } = await supabaseClient
    .from('resources')
    .select(RESOURCE_COLUMNS)
    .order('added_at', { ascending: false })
    .order('id', { ascending: false });
  if(error){ console.error(error); showToast('Could not load resources — check Supabase setup.'); return []; }
  return data.map(mapResourceRow);
}

async function loadSettings(){
  if(!CONFIGURED) return { ...DEFAULT_SETTINGS, categories: [], tidbitTopics: [], tidbitGroups: [], topicGroups: {} };
  const { data, error } = await supabaseClient.from('site_settings').select(SETTINGS_COLUMNS).eq('id', 1).single();
  if(error || !data) return { ...DEFAULT_SETTINGS, categories: [], tidbitTopics: [], tidbitGroups: [], topicGroups: {} };
  return {
    title: data.title, subtitle: data.subtitle,
    categories: data.categories || [],
    tidbitTopics: data.tidbit_topics || [],
    tidbitGroups: data.tidbit_groups || [],
    topicGroups: data.topic_groups || {}
  };
}

/* ---------------- Categories (stored as a text[] column on site_settings) ---------------- */
async function loadCategories(){
  if(!CONFIGURED){
    const set = new Set();
    SEED_RESOURCES.forEach(r => { if(r.category && r.category.toLowerCase() !== 'uncategorized') set.add(r.category); });
    return [...set].sort((a,b)=> a.localeCompare(b));
  }
  if(settings.categories && settings.categories.length){
    const cleaned = settings.categories.filter(c => c && c.toLowerCase() !== 'uncategorized');
    if(cleaned.length !== settings.categories.length) void saveCategoriesRow(cleaned); // repair without delaying first paint
    return cleaned;
  }
  // Nothing saved yet (e.g. first run after adding this feature) — derive a
  // starting list from whatever categories already exist on resources.
  const set = new Set();
  resources.forEach(r => { if(r.category && r.category.toLowerCase() !== 'uncategorized') set.add(r.category); });
  const derived = [...set].sort((a,b)=> a.localeCompare(b));
  if(derived.length) void saveCategoriesRow(derived);
  return derived;
}

async function saveCategoriesRow(cats){
  if(!CONFIGURED) return true;
  const { error } = await supabaseClient.from('site_settings').upsert({
    id: 1, title: settings.title, subtitle: settings.subtitle, categories: cats
  });
  if(error){ console.error(error); showToast('Save failed: ' + error.message); return false; }
  return true;
}

async function addCategory(name){
  name = (name||'').trim();
  if(!name) return false;
  if(name.toLowerCase() === 'uncategorized'){
    showToast('"Uncategorized" is built in already — pick that from the dropdown instead');
    return false;
  }
  if(categories.some(c => c.toLowerCase() === name.toLowerCase())){
    showToast('That category already exists');
    return false;
  }
  const updated = [...categories, name]; // new categories land at the end — drag to reposition
  if(CONFIGURED){
    const ok = await saveCategoriesRow(updated);
    if(!ok) return false;
  }
  categories = updated;
  return true;
}

async function removeCategory(name){
  const affected = resources.filter(r => r.category === name);
  const updated = categories.filter(c => c !== name);
  if(CONFIGURED){
    for(const r of affected){
      await updateResourceRow(r.id, { title:r.title, description:r.description, type:r.type, url:r.url, category:'', tags:r.tags });
    }
    const ok = await saveCategoriesRow(updated);
    if(!ok) return false;
  }
  affected.forEach(r => { r.category = ''; });
  categories = updated;
  return true;
}

// Persists a full drag-and-drop reordering. This order is the single source
// of truth for how categories appear everywhere (sidebar list + feed
// sections) — see orderNamesBy().
async function reorderCategories(newOrder){
  const updated = [...newOrder];
  if(CONFIGURED){
    const ok = await saveCategoriesRow(updated);
    if(!ok) return false;
  }
  categories = updated;
  return true;
}

async function renameCategory(oldName, newNameRaw){
  const newName = (newNameRaw||'').trim();
  if(!newName || newName === oldName) return false;
  if(newName.toLowerCase() === 'uncategorized'){
    showToast('"Uncategorized" is reserved — pick a different name');
    return false;
  }
  if(categories.some(c => c.toLowerCase() === newName.toLowerCase() && c !== oldName)){
    showToast('That category already exists');
    return false;
  }
  const affected = resources.filter(r => r.category === oldName);
  const updated = categories.map(c => c === oldName ? newName : c); // renaming keeps its position in the drag order
  if(CONFIGURED){
    for(const r of affected){
      await updateResourceRow(r.id, { title:r.title, description:r.description, type:r.type, url:r.url, category:newName, tags:r.tags });
    }
    const ok = await saveCategoriesRow(updated);
    if(!ok) return false;
  }
  affected.forEach(r => { r.category = newName; });
  categories = updated;
  return true;
}

async function insertResource(r){
  const { data, error } = await supabaseClient.from('resources').insert({
    title: r.title, description: r.description, type: r.type, url: r.url, category: r.category, tags: r.tags, source_text: r.sourceText || '',
    icon_url: r.iconUrl || '', app_store_url: r.appStoreUrl || '', screenshots: r.screenshots || []
  }).select(RESOURCE_COLUMNS).single();
  if(error){ console.error(error); showToast('Save failed: ' + error.message); return null; }
  return { id: data.id, title: data.title, description: data.description || '', type: data.type, url: data.url || '', category: data.category || 'Uncategorized', tags: data.tags || [], sourceText: data.source_text || '', iconUrl: data.icon_url || '', appStoreUrl: data.app_store_url || '', screenshots: data.screenshots || [], addedAt: new Date(data.added_at).getTime() };
}

async function updateResourceRow(id, r){
  const { error } = await supabaseClient.from('resources').update({
    title: r.title, description: r.description, type: r.type, url: r.url, category: r.category, tags: r.tags, source_text: r.sourceText || '',
    icon_url: r.iconUrl || '', app_store_url: r.appStoreUrl || '', screenshots: r.screenshots || []
  }).eq('id', id);
  if(error){ console.error(error); showToast('Save failed: ' + error.message); return false; }
  return true;
}

async function deleteResourceRow(id){
  const { error } = await supabaseClient.from('resources').delete().eq('id', id);
  if(error){ console.error(error); showToast('Delete failed: ' + error.message); return false; }
  return true;
}

async function saveSettingsRow(s){
  const { error } = await supabaseClient.from('site_settings').upsert({ id: 1, title: s.title, subtitle: s.subtitle });
  if(error){ console.error(error); showToast('Save failed: ' + error.message); return false; }
  return true;
}

/* ---------------- Auth ---------------- */
async function checkSession(){
  if(!CONFIGURED) return false;
  const { data } = await supabaseClient.auth.getSession();
  return !!(data && data.session);
}
async function loginWithPassword(email, password){
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  return error ? error.message : null;
}
async function logoutAdmin(){
  if(CONFIGURED) await supabaseClient.auth.signOut();
}

/* ---------------- Tidbits (topic-carded field notes extracted from a resource) ----------------
   Every tidbit belongs to exactly one resource (resource_id, cascade-deletes
   with it) — that's the two-way relationship: a resource can list all its
   tidbits, and a tidbit always knows and shows its source. Topics are the
   card groupings shown in "Field Notes," managed the same way categories are. */
async function loadTidbits(){
  if(!CONFIGURED) return [];
  const { data, error } = await supabaseClient.from('tidbits').select(TIDBIT_COLUMNS).order('position', { ascending: true });
  if(error){ console.error(error); return []; }
  return data.map(t => ({
    id: t.id,
    resourceId: t.resource_id,
    topic: t.topic || 'General',
    text: t.text,
    position: t.position || 0
  }));
}

async function loadTidbitTopics(){
  if(!CONFIGURED){
    const set = new Set(tidbits.map(t=>t.topic).filter(t => t && t.toLowerCase() !== 'general'));
    return [...set].sort((a,b)=> a.localeCompare(b));
  }
  if(settings.tidbitTopics && settings.tidbitTopics.length){
    const cleaned = settings.tidbitTopics.filter(t => t && t.toLowerCase() !== 'general');
    if(cleaned.length !== settings.tidbitTopics.length) void saveTidbitTopicsRow(cleaned);
    return [...cleaned].sort((a,b)=> a.localeCompare(b));
  }
  const set = new Set(tidbits.map(t=>t.topic).filter(t => t && t.toLowerCase() !== 'general'));
  const derived = [...set].sort((a,b)=> a.localeCompare(b));
  if(derived.length) void saveTidbitTopicsRow(derived);
  return derived;
}

async function saveTidbitTopicsRow(topicsArr){
  if(!CONFIGURED) return true;
  const { error } = await supabaseClient.from('site_settings').upsert({
    id: 1, title: settings.title, subtitle: settings.subtitle, tidbit_topics: topicsArr
  });
  if(error){ console.error(error); showToast('Save failed: ' + error.message); return false; }
  return true;
}

async function addTidbitTopic(name){
  name = (name||'').trim();
  if(!name) return false;
  if(name.toLowerCase() === 'general'){
    showToast('"General" is built in already — pick that from the dropdown instead');
    return false;
  }
  if(tidbitTopics.some(t => t.toLowerCase() === name.toLowerCase())){
    showToast('That topic already exists');
    return false;
  }
  const updated = [...tidbitTopics, name].sort((a,b)=> a.localeCompare(b));
  if(CONFIGURED){
    const ok = await saveTidbitTopicsRow(updated);
    if(!ok) return false;
  }
  tidbitTopics = updated;
  return true;
}

async function removeTidbitTopic(name){
  const affected = tidbits.filter(t => t.topic === name);
  const updated = tidbitTopics.filter(t => t !== name);
  if(CONFIGURED){
    for(const t of affected){
      await updateTidbitRow(t.id, { topic: 'General', text: t.text, position: t.position });
    }
    const ok = await saveTidbitTopicsRow(updated);
    if(!ok) return false;
  }
  affected.forEach(t => { t.topic = 'General'; });
  tidbitTopics = updated;
  return true;
}

async function renameTidbitTopic(oldName, newNameRaw){
  const newName = (newNameRaw||'').trim();
  if(!newName || newName === oldName) return false;
  if(newName.toLowerCase() === 'general'){
    showToast('"General" is reserved — pick a different name');
    return false;
  }
  if(tidbitTopics.some(t => t.toLowerCase() === newName.toLowerCase() && t !== oldName)){
    showToast('That topic already exists');
    return false;
  }
  const affected = tidbits.filter(t => t.topic === oldName);
  const updatedTopics = tidbitTopics.map(t => t === oldName ? newName : t).sort((a,b)=> a.localeCompare(b));
  const updatedMap = { ...topicGroups };
  if(oldName in updatedMap){ updatedMap[newName] = updatedMap[oldName]; delete updatedMap[oldName]; }
  if(CONFIGURED){
    for(const t of affected){
      await updateTidbitRow(t.id, { topic: newName, text: t.text, position: t.position, resourceId: t.resourceId });
    }
    const ok1 = await saveTidbitTopicsRow(updatedTopics);
    const ok2 = await saveTopicGroupsRow(updatedMap);
    if(!ok1 || !ok2) return false;
  }
  affected.forEach(t => { t.topic = newName; });
  tidbitTopics = updatedTopics;
  topicGroups = updatedMap;
  return true;
}

/* ---------------- Tidbit groups (top-level sections above topics, e.g. Clubs, Academics, Dining) ---------------- */
async function loadTidbitGroups(){
  if(!CONFIGURED) return [];
  return settings.tidbitGroups || [];
}

async function saveTidbitGroupsRow(groupsArr){
  if(!CONFIGURED) return true;
  const { error } = await supabaseClient.from('site_settings').upsert({
    id: 1, title: settings.title, subtitle: settings.subtitle, tidbit_groups: groupsArr
  });
  if(error){ console.error(error); showToast('Save failed: ' + error.message); return false; }
  return true;
}

async function saveTopicGroupsRow(map){
  if(!CONFIGURED) return true;
  const { error } = await supabaseClient.from('site_settings').upsert({
    id: 1, title: settings.title, subtitle: settings.subtitle, topic_groups: map
  });
  if(error){ console.error(error); showToast('Save failed: ' + error.message); return false; }
  return true;
}

async function addTidbitGroup(name){
  name = (name||'').trim();
  if(!name) return false;
  if(tidbitGroups.some(g => g.toLowerCase() === name.toLowerCase())){
    showToast('That group already exists');
    return false;
  }
  const updated = [...tidbitGroups, name]; // new groups land at the end — drag to reposition
  if(CONFIGURED){
    const ok = await saveTidbitGroupsRow(updated);
    if(!ok) return false;
  }
  tidbitGroups = updated;
  return true;
}

async function renameTidbitGroup(oldName, newNameRaw){
  const newName = (newNameRaw||'').trim();
  if(!newName || newName === oldName) return false;
  if(tidbitGroups.some(g => g.toLowerCase() === newName.toLowerCase() && g !== oldName)){
    showToast('That group already exists');
    return false;
  }
  const updatedGroups = tidbitGroups.map(g => g === oldName ? newName : g); // keeps its position in the drag order
  const updatedMap = { ...topicGroups };
  Object.keys(updatedMap).forEach(topic => { if(updatedMap[topic] === oldName) updatedMap[topic] = newName; });
  if(CONFIGURED){
    const ok1 = await saveTidbitGroupsRow(updatedGroups);
    const ok2 = await saveTopicGroupsRow(updatedMap);
    if(!ok1 || !ok2) return false;
  }
  tidbitGroups = updatedGroups;
  topicGroups = updatedMap;
  return true;
}

async function removeTidbitGroup(name){
  const updatedGroups = tidbitGroups.filter(g => g !== name);
  const updatedMap = { ...topicGroups };
  Object.keys(updatedMap).forEach(topic => { if(updatedMap[topic] === name) delete updatedMap[topic]; });
  if(CONFIGURED){
    const ok1 = await saveTidbitGroupsRow(updatedGroups);
    const ok2 = await saveTopicGroupsRow(updatedMap);
    if(!ok1 || !ok2) return false;
  }
  tidbitGroups = updatedGroups;
  topicGroups = updatedMap;
  return true;
}

// Persists a full drag-and-drop reordering — the single source of truth for
// how groups appear everywhere (sidebar list + Field Notes sections).
async function reorderTidbitGroups(newOrder){
  const updated = [...newOrder];
  if(CONFIGURED){
    const ok = await saveTidbitGroupsRow(updated);
    if(!ok) return false;
  }
  tidbitGroups = updated;
  return true;
}

async function setTopicGroup(topic, groupName){
  const updated = { ...topicGroups };
  if(groupName){ updated[topic] = groupName; } else { delete updated[topic]; }
  if(CONFIGURED){
    const ok = await saveTopicGroupsRow(updated);
    if(!ok) return false;
  }
  topicGroups = updated;
  return true;
}

function groupForTopic(topic){
  return topicGroups[topic] || 'Ungrouped';
}

/* ---------------- Tags (freeform on resources) ---------------- */
async function renameTag(oldName, newNameRaw){
  const newName = (newNameRaw||'').trim();
  if(!newName || newName === oldName) return false;
  const affected = resources.filter(r => (r.tags||[]).includes(oldName));
  if(CONFIGURED){
    for(const r of affected){
      const newTags = [...new Set(r.tags.map(t => t === oldName ? newName : t))];
      const ok = await updateResourceRow(r.id, { title:r.title, description:r.description, type:r.type, url:r.url, category:r.category, tags:newTags });
      if(!ok) return false;
      r.tags = newTags;
    }
  } else {
    affected.forEach(r => { r.tags = [...new Set(r.tags.map(t => t === oldName ? newName : t))]; });
  }
  return true;
}

async function insertTidbit(t){
  if(!CONFIGURED){
    return { id: 't' + Date.now() + Math.random().toString(36).slice(2,6), resourceId: t.resourceId, topic: t.topic, text: t.text, position: t.position || 0 };
  }
  const { data, error } = await supabaseClient.from('tidbits').insert({
    resource_id: t.resourceId, topic: t.topic, text: t.text, position: t.position || 0
  }).select(TIDBIT_COLUMNS).single();
  if(error){ console.error(error); showToast('Save failed: ' + error.message); return null; }
  return { id: data.id, resourceId: data.resource_id, topic: data.topic, text: data.text, position: data.position };
}

async function updateTidbitRow(id, t){
  if(!CONFIGURED) return true;
  const payload = { topic: t.topic, text: t.text, position: t.position };
  // resourceId is optional here so callers that only move a tidbit between
  // topic cards don't have to know or resend its current source.
  if('resourceId' in t) payload.resource_id = t.resourceId;
  const { error } = await supabaseClient.from('tidbits').update(payload).eq('id', id);
  if(error){ console.error(error); showToast('Save failed: ' + error.message); return false; }
  return true;
}

async function unlinkTidbitsFromResource(resourceId){
  if(!CONFIGURED) return true;
  const { error } = await supabaseClient.from('tidbits').update({ resource_id: null }).eq('resource_id', resourceId);
  if(error){ console.error(error); showToast('Update failed: ' + error.message); return false; }
  return true;
}

async function deleteTidbitRow(id){
  if(!CONFIGURED) return true;
  const { error } = await supabaseClient.from('tidbits').delete().eq('id', id);
  if(error){ console.error(error); showToast('Delete failed: ' + error.message); return false; }
  return true;
}

/* ---------------- Init ---------------- */
async function init(){
  if(!CONFIGURED){
    const banner = document.getElementById('configBanner');
    banner.style.display = 'block';
    banner.innerHTML = `<div style="max-width:1180px;margin:0 auto;padding:10px 28px;background:#F1DACB;color:#7A3712;font-size:13.5px;">
      Supabase isn't configured yet — showing sample data only, nothing will save. Add your project URL and anon key near the top of the script.
    </div>`;
  }

  // Start every request together, but paint as soon as the first resource page
  // arrives. The other requests continue while the visitor can already browse.
  const firstResourcesPromise = loadResourcePage(0, RESOURCE_PAGE_SIZE - 1);
  const settingsPromise = loadSettings();
  const tidbitsPromise = loadTidbits();
  const sessionPromise = checkSession();

  try{
    resources = (await firstResourcesPromise) || [];
  }catch(err){
    console.error(err);
    resources = [];
  }

  settings = { ...DEFAULT_SETTINGS, categories: [], tidbitTopics: [], tidbitGroups: [], topicGroups: {} };
  tidbits = [];
  categories = await loadCategories();
  tidbitTopics = [];
  tidbitGroups = [];
  topicGroups = {};

  document.getElementById('siteTitle').textContent = 'Wally Wiki';
  document.title = 'Wally Wiki';

  const sidebarSubtitle = document.getElementById('sidebarSubtitle');
  if(sidebarSubtitle){
    sidebarSubtitle.textContent = settings.subtitle || DEFAULT_SETTINGS.subtitle;
  }

  renderHeaderActions();
  renderAll();

  // Older resources are lower priority. Add them in small batches so the
  // browser stays responsive and each batch becomes visible progressively.
  void loadRemainingResources();

  const [loadedSettings, loadedTidbits, adminSession] = await Promise.all([
    settingsPromise,
    tidbitsPromise,
    sessionPromise
  ]);
  settings = loadedSettings;
  tidbits = loadedTidbits;
  isAdmin = adminSession;
  topicGroups = settings.topicGroups || {};
  [categories, tidbitTopics] = await Promise.all([loadCategories(), loadTidbitTopics()]);
  tidbitGroups = await loadTidbitGroups();
  renderHeaderActions();
  renderAll();
}

async function loadRemainingResources(){
  for(let from = RESOURCE_PAGE_SIZE;; from += RESOURCE_PAGE_SIZE){
    const page = await loadResourcePage(from, from + RESOURCE_PAGE_SIZE - 1);
    if(!page || !page.length) return;
    resources.push(...page);
    renderAll();
    if(page.length < RESOURCE_PAGE_SIZE) return;
  }
}

/* ---------------- Auto-tag parsing engine ---------------- */
const STOPWORDS = new Set(['the','a','an','and','or','but','for','of','to','in','on','at','with','is','are','was','were','be','been','this','that','it','you','your','our','we','they','their','from','by','as','can','will','if','not','no','yes','into','about','over','out','up','down','than','then','also','just','have','has','had','need','needs','make','made','some','any','all','more','most','so','do','does',
  // Every resource on this site is already about Harvey Mudd / the 5Cs, so
  // these carry no filtering value as tags — keep them out of the
  // frequency-based fallback tagger too (mirrors TAG_GUIDANCE in the AI prompt).
  'hmc','harvey','mudd','claremont','colleges','college','5c','5cs']);

function autoTags(title, description, type){
  const text = ((title||'') + ' ' + (description||'')).toLowerCase();
  const words = text.match(/[a-z0-9']+/g) || [];
  const freq = {};
  words.forEach(w=>{
    if(w.length > 2 && !STOPWORDS.has(w)){
      freq[w] = (freq[w]||0) + 1;
    }
  });
  let ranked = Object.keys(freq).sort((a,b)=> freq[b]-freq[a]);
  let tags = ranked.slice(0,3).map(w => w.charAt(0).toUpperCase() + w.slice(1));
  if(type === 'info' && !tags.includes('Event')) {
    // no forced tag, just leave inference to content
  }
  return [...new Set(tags)];
}

/* ---------------- Auto-description engine ---------------- */
function autoDescription(title, type, url){
  const t = (title||'').trim();
  if(!t) return '';

  let domain = '';
  if(url){
    try{ domain = new URL(url).hostname.replace(/^www\./,''); }catch(e){ domain = ''; }
  }

  if(type === 'file'){
    return domain
      ? `A downloadable file: ${t}, hosted on ${domain}.`
      : `A downloadable file: ${t}.`;
  }
  if(type === 'info'){
    return `${t} — no link needed, just what students should know.`;
  }
  if(type === 'app'){
    return `A mobile app: ${t}.`;
  }
  // link
  return domain
    ? `A link to ${domain} for ${t}.`
    : `A link related to ${t}.`;
}

/* ---------------- App Store lookup (for the "App" resource type) ----------------
   Uses Apple's public iTunes Search/Lookup API — it's free, needs no key, and
   returns CORS headers so it can be called straight from the browser. It gives
   us the icon, screenshots, and description directly as JSON — no scraping.
   There's no equivalent public API for Google Play, so Android screenshots
   have to be added manually (see the Screenshots textarea in the form). */
async function fetchAppStoreInfo(input){
  input = (input || '').trim();
  if(!input) return { error: 'Enter an App Store link or the app\'s name first.' };

  const idMatch = input.match(/id(\d{6,})/);
  let apiUrl;
  if(idMatch){
    apiUrl = `https://itunes.apple.com/lookup?id=${idMatch[1]}`;
  } else if(/^https?:\/\//i.test(input)){
    return { error: "That doesn't look like an App Store link (apps.apple.com/…) — try pasting that instead, or just type the app's name." };
  } else {
    apiUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(input)}&entity=software&limit=1`;
  }

  try{
    const res = await fetch(apiUrl);
    if(!res.ok) return { error: `App Store lookup failed (status ${res.status}).` };
    const data = await res.json();
    const item = data.results && data.results[0];
    if(!item) return { error: 'No matching app found on the App Store.' };
    const description = (item.description || '').split(/\n+/)[0].slice(0, 300);
    const screenshots = [...(item.screenshotUrls || []), ...(item.ipadScreenshotUrls || [])].slice(0, 10);
    return {
      title: item.trackName || '',
      description,
      icon: item.artworkUrl512 || item.artworkUrl100 || '',
      screenshots,
      appStoreUrl: item.trackViewUrl || input
    };
  } catch(e){
    return { error: "Couldn't reach the App Store — check your connection and try again." };
  }
}

/* ---------------- Derived data ---------------- */
function allTags(){
  const counts = {};
  resources.forEach(r => (r.tags||[]).forEach(t => { counts[t] = (counts[t]||0)+1; }));
  return Object.entries(counts).sort((a,b)=> b[1]-a[1]);
}

function allCategories(){
  const counts = {};
  resources.forEach(r=>{
    const c = r.category || 'Uncategorized';
    counts[c] = (counts[c]||0) + 1;
  });
  return orderNamesBy(Object.keys(counts), categories, 'Uncategorized').map(name => [name, counts[name]]);
}

function slugify(s){
  return (s||'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'') || 'category';
}

// Orders a list of names by their position in a canonical, admin-reorderable
// array (categories / tidbitGroups) — this is the single source of truth
// used everywhere something needs to show categories or groups in order, so
// the sidebar and the feed can never drift apart. Names not yet present in
// the canonical array (e.g. a category that only exists on old resources)
// sort alphabetically after the known ones; `pinLast`, if given, always sorts
// to the very end regardless of position (used for "Uncategorized"/"Ungrouped").
function orderNamesBy(names, orderArray, pinLast){
  const rank = new Map(orderArray.map((n,i)=>[n,i]));
  return [...names].sort((a,b)=>{
    if(pinLast){
      if(a === pinLast) return 1;
      if(b === pinLast) return -1;
    }
    const ra = rank.has(a) ? rank.get(a) : Infinity;
    const rb = rank.has(b) ? rank.get(b) : Infinity;
    if(ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}

function filteredResources(){
  return resources.filter(r=>{
    if(activeType && r.type !== activeType) return false;
    if(activeTag && !(r.tags||[]).includes(activeTag)) return false;
    if(searchQuery){
      const hay = (r.title+' '+r.description+' '+(r.category||'')+' '+(r.tags||[]).join(' ')).toLowerCase();
      if(!hay.includes(searchQuery.toLowerCase())) return false;
    }
    return true;
  }).sort((a,b)=> b.addedAt - a.addedAt);
}

/* ---------------- Rendering ---------------- */
function renderHeaderActions(){
  const el = document.getElementById('headerActions');
  el.innerHTML = '';
  if(isAdmin){
    el.innerHTML = `
      <button class="btn btn-accent" id="addResourceBtn">Add resource</button>
      <button class="btn" id="importTidbitsBtn">Import tips</button>
      <button class="btn" id="categoriesBtn">Categories</button>
      <button class="btn" id="tagsBtn">Tags</button>
      <button class="btn" id="settingsBtn">Settings</button>
      <button class="btn btn-ghost" id="logoutBtn">Log out</button>
    `;
    document.getElementById('addResourceBtn').onclick = () => openResourceModal(null);
    document.getElementById('importTidbitsBtn').onclick = openImportTidbitsModal;
    document.getElementById('categoriesBtn').onclick = openCategoriesModal;
    document.getElementById('tagsBtn').onclick = openTagsModal;
    document.getElementById('settingsBtn').onclick = openSettingsModal;
    document.getElementById('logoutBtn').onclick = async () => { await logoutAdmin(); isAdmin = false; renderHeaderActions(); renderAll(); showToast('Logged out'); };
  } else {
    el.innerHTML = `
      <button class="btn" id="adminBtn">Admin</button>
      <a class="btn btn-accent" href="https://forms.gle/zWMLEWrWbmnddp638" target="_blank" rel="noopener">Contribute</a>
    `;
    document.getElementById('adminBtn').onclick = openLoginModal;
  }
}

function renderSidebar(){
  renderSidebarResources();
  renderSidebarTidbits();
}

function renderSidebarResources(){
  const catEl = document.getElementById('categoryNav');
  const cats = allCategories();
  if(cats.length === 0){
    catEl.innerHTML = `<div style="font-size:13px;color:var(--ink-faint);">No categories yet</div>`;
  } else {
    catEl.innerHTML = cats.map(([cat,count])=>{
      return `<button class="tag-item" data-jump="${escapeAttr(slugify(cat))}" data-jump-cat="${escapeAttr(cat)}">
        <span>${escapeHtml(cat)}</span><span class="count">${count}</span>
      </button>`;
    }).join('');
    catEl.querySelectorAll('[data-jump]').forEach(btn=>{
      btn.onclick = ()=>{
        activeTag = null; activeType = null; searchQuery = '';
        document.getElementById('searchInput').value = '';
        // Jumping to a collapsed section should reveal it, not scroll to a
        // header with nothing visible underneath.
        if(collapsedCategories.delete(btn.dataset.jumpCat)) saveCollapsedCategories();
        renderAll();
        requestAnimationFrame(()=>{
          const target = document.getElementById('cat-' + btn.dataset.jump);
          if(target) target.scrollIntoView({ behavior:'smooth', block:'start' });
        });
      };
    });
  }

  const typeEl = document.getElementById('typeFilter');
  const types = [
    {key:'link', label:'Link'},
    {key:'file', label:'File'},
    {key:'info', label:'No link'},
    {key:'app', label:'App'}
  ];
  typeEl.innerHTML = types.map(t=>{
    const count = resources.filter(r=>r.type===t.key).length;
    const active = activeType === t.key;
    return `<button class="tag-item ${active?'active':''}" data-type="${t.key}">
      <span>${t.label}</span><span class="count">${count}</span>
    </button>`;
  }).join('');
  typeEl.querySelectorAll('[data-type]').forEach(btn=>{
    btn.onclick = ()=>{
      const t = btn.dataset.type;
      activeType = activeType === t ? null : t;
      renderAll();
    };
  });

  const tagsEl = document.getElementById('tagList');
  const tags = allTags();
  if(tags.length === 0){
    tagsEl.innerHTML = `<div style="font-size:13px;color:var(--ink-faint);">No tags yet</div>`;
  } else {
    tagsEl.innerHTML = tags.map(([tag,count])=>{
      const active = activeTag === tag;
      return `<button class="tag-item ${active?'active':''}" data-tag="${escapeAttr(tag)}">
        <span>${escapeHtml(tag)}</span><span class="count">${count}</span>
      </button>`;
    }).join('');
    tagsEl.querySelectorAll('[data-tag]').forEach(btn=>{
      btn.onclick = ()=>{
        const t = btn.dataset.tag;
        activeTag = activeTag === t ? null : t;
        renderAll();
      };
    });
  }

  document.getElementById('clearFilters').style.display = (activeTag || activeType || searchQuery) ? 'block' : 'none';
  updateSidebarToggleLabel();
}

function renderSidebarTidbits(){
  const groupEl = document.getElementById('groupNav');
  const groupsInUse = [...new Set(tidbits.map(t => groupForTopic(t.topic)))];
  const orderedGroups = orderNamesBy(groupsInUse, tidbitGroups, 'Ungrouped');
  if(orderedGroups.length === 0){
    groupEl.innerHTML = `<div style="font-size:13px;color:var(--ink-faint);">No groups yet</div>`;
  } else {
    groupEl.innerHTML = orderedGroups.map(g=>{
      const count = tidbits.filter(t => groupForTopic(t.topic) === g).length;
      return `<button class="tag-item" data-jump-group="${escapeAttr(slugify(g))}" data-jump-group-name="${escapeAttr(g)}">
        <span>${escapeHtml(g)}</span><span class="count">${count}</span>
      </button>`;
    }).join('');
    groupEl.querySelectorAll('[data-jump-group]').forEach(btn=>{
      btn.onclick = ()=>{
        activeTopicFilter = null;
        // Jumping to a collapsed group should reveal it, not scroll to a
        // header with nothing visible under it.
        if(collapsedGroups.delete(btn.dataset.jumpGroupName)) saveCollapsedGroups();
        renderFieldNotes();
        requestAnimationFrame(()=>{
          const target = document.getElementById('group-' + btn.dataset.jumpGroup);
          if(target) target.scrollIntoView({ behavior:'smooth', block:'start' });
        });
      };
    });
  }

  const topicEl = document.getElementById('topicFilter');
  const topicsInUse = [...new Set(tidbits.map(t => t.topic || 'General'))].sort((a,b)=>{
    if(a==='General') return 1;
    if(b==='General') return -1;
    return a.localeCompare(b);
  });
  if(topicsInUse.length === 0){
    topicEl.innerHTML = `<div style="font-size:13px;color:var(--ink-faint);">No topics yet</div>`;
  } else {
    topicEl.innerHTML = topicsInUse.map(t=>{
      const count = tidbits.filter(x => (x.topic||'General') === t).length;
      const active = activeTopicFilter === t;
      return `<button class="tag-item ${active?'active':''}" data-topic-filter="${escapeAttr(t)}">
        <span>${escapeHtml(t)}</span><span class="count">${count}</span>
      </button>`;
    }).join('');
    topicEl.querySelectorAll('[data-topic-filter]').forEach(btn=>{
      btn.onclick = ()=>{
        const t = btn.dataset.topicFilter;
        activeTopicFilter = activeTopicFilter === t ? null : t;
        renderFieldNotes();
      };
    });
  }
}

// Which sidebar panel shows (Resources vs Tidbits filters) tracks which
// section of the page is currently in view, rather than being a fixed tab.
function setupSidebarScrollSync(){
  const resourcesPanel = document.getElementById('sidebarResourcesPanel');
  const tidbitsPanel = document.getElementById('sidebarTidbitsPanel');
  const mainEl = document.querySelector('main');
  const fieldNotesSection = document.getElementById('fieldNotesSection');
  if(!resourcesPanel || !tidbitsPanel || !mainEl) return;

  resourcesPanel.style.display = 'block';
  tidbitsPanel.style.display = 'block';
}

function cardHtml(r){
  const typeLabels = {link:'Link', file:'File', info:'No link', app:'App'};
  const chips = (r.tags||[]).map(t=>`<span class="chip" data-chip="${escapeAttr(t)}">${escapeHtml(t)}</span>`).join('');
  const isApp = r.type === 'app';
  const linkHtml = r.url ? `<a class="card-link" href="${escapeAttr(r.url)}" target="_blank" rel="noopener">${isApp ? 'App Store ↗' : 'View source ↗'}</a>` : `<span></span>`;
  const cardUrlAttr = r.url ? ` data-url="${escapeAttr(r.url)}"` : '';
  const adminActions = isAdmin ? `
    <div class="card-admin-actions">
      <button class="icon-btn" data-edit="${r.id}">Edit</button>
      <button class="icon-btn del" data-del="${r.id}">Delete</button>
    </div>` : '';
  const tidbitCount = tidbits.filter(t=>t.resourceId===r.id).length;
  const tidbitLink = tidbitCount
    ? `<button class="card-tidbit-link" data-view-tidbits="${r.id}">${tidbitCount} tip${tidbitCount===1?'':'s'} →</button>`
    : '';
  const iconHtml = (isApp && r.iconUrl) ? `<img class="app-card-icon" src="${escapeAttr(r.iconUrl)}" alt="">` : '';
  const screensHint = (isApp && (r.screenshots||[]).length) ? `<span class="app-screens-hint">Tap the card for screenshots →</span>` : '';
  return `<div class="card type-${r.type}" data-id="${r.id}"${cardUrlAttr}>
    <div class="card-top">
      <div class="card-top-left">
        ${iconHtml}
        <h3 class="card-title">${escapeHtml(r.title)}</h3>
      </div>
      <span class="type-badge">${typeLabels[r.type]}</span>
    </div>
    <p class="card-desc">${escapeHtml(r.description)}</p>
    <div class="tag-chips">${chips}</div>
    <div class="card-bottom">
      ${linkHtml}
      ${adminActions}
    </div>
    ${tidbitLink}
    ${screensHint}
  </div>`;
}

function bindCardEvents(container){
  container.querySelectorAll('[data-chip]').forEach(chip=>{
    chip.onclick = ()=>{ activeTag = chip.dataset.chip; renderAll(); };
  });
  container.querySelectorAll('[data-view-tidbits]').forEach(btn=>{
    btn.onclick = ()=>{
      openResourceTidbitsModal(btn.dataset.viewTidbits);
    };
  });
  if(isAdmin){
    container.querySelectorAll('[data-edit]').forEach(btn=>{
      btn.onclick = ()=> openResourceModal(btn.dataset.edit);
    });
    container.querySelectorAll('[data-del]').forEach(btn=>{
      btn.onclick = ()=> confirmDelete(btn.dataset.del, btn);
    });
  }
  // Clicking anywhere on a non-app card with a URL opens the destination in a
  // new tab, while app cards still open the app detail view.
  container.querySelectorAll('.card:not(.type-app)[data-url]').forEach(card=>{
    card.addEventListener('click', (e)=>{
      if(e.target.closest('a,button,[data-chip]')) return;
      window.open(card.dataset.url, '_blank', 'noopener,noreferrer');
    });
  });

  // Clicking anywhere on an "app" card (except its links/buttons/chips) opens
  // the screenshot detail view.
  container.querySelectorAll('.card.type-app').forEach(card=>{
    card.addEventListener('click', (e)=>{
      if(e.target.closest('a,button,[data-chip]')) return;
      openAppDetailModal(card.dataset.id);
    });
  });
}

function renderMain(){
  const container = document.getElementById('grid');
  const noFilters = !activeTag && !activeType && !searchQuery;
  if(noFilters){
    renderGroupedView(container);
  } else {
    renderFlatView(container);
  }
}

function renderFlatView(grid){
  const list = filteredResources();
  document.getElementById('resultsMeta').textContent = `${list.length} resource${list.length===1?'':'s'}`;
  grid.className = 'grid';

  if(list.length === 0){
    grid.style.display = 'block';
    grid.innerHTML = `<div class="empty-state">
      <p>Nothing matches these filters.</p>
      <button class="btn btn-sm" id="emptyClear">Clear filters</button>
    </div>`;
    const btn = document.getElementById('emptyClear');
    if(btn) btn.onclick = ()=>{ activeTag=null; activeType=null; searchQuery=''; document.getElementById('searchInput').value=''; renderAll(); };
    return;
  }
  grid.style.display = 'grid';
  grid.innerHTML = list.map(cardHtml).join('');
  bindCardEvents(grid);
}

function renderGroupedView(container){
  container.style.display = 'block';
  container.className = 'category-list';

  if(resources.length === 0){
    document.getElementById('resultsMeta').textContent = '0 resources';
    container.innerHTML = `<div class="empty-state"><p>No resources yet.</p></div>`;
    return;
  }

  // Group resources by their single category — every resource lives in exactly one section
  const groups = {};
  resources.forEach(r=>{
    const c = r.category || 'Uncategorized';
    if(!groups[c]) groups[c] = [];
    groups[c].push(r);
  });

  const entries = orderNamesBy(Object.keys(groups), categories, 'Uncategorized').map(name => [name, groups[name]]);

  document.getElementById('resultsMeta').textContent =
    `${resources.length} resource${resources.length===1?'':'s'} across ${entries.length} categor${entries.length===1?'y':'ies'}`;

  container.innerHTML = entries.map(([cat, items])=>{
    const sorted = [...items].sort((a,b)=> b.addedAt - a.addedAt);
    const isCollapsed = collapsedCategories.has(cat);
    return `<section class="category-section${isCollapsed ? ' collapsed' : ''}" id="cat-${slugify(cat)}">
      <button type="button" class="category-header" data-toggle-cat="${escapeAttr(cat)}" aria-expanded="${isCollapsed ? 'false' : 'true'}">
        <span class="category-toggle-icon" aria-hidden="true">▾</span>
        <h2>${escapeHtml(cat)}</h2>
        <span class="category-count">${items.length}</span>
      </button>
      <div class="grid">${sorted.map(cardHtml).join('')}</div>
    </section>`;
  }).join('');

  bindCardEvents(container);

  container.querySelectorAll('[data-toggle-cat]').forEach(btn=>{
    btn.onclick = ()=>{
      const cat = btn.dataset.toggleCat;
      const section = btn.closest('.category-section');
      const nowCollapsed = !section.classList.contains('collapsed');
      section.classList.toggle('collapsed', nowCollapsed);
      btn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
      if(nowCollapsed) collapsedCategories.add(cat); else collapsedCategories.delete(cat);
      saveCollapsedCategories();
    };
  });
}

function renderAll(){
  renderSidebar();
  renderMain();
  renderFieldNotes();
}

/* ---------------- Field Notes: grouped cards with expandable tidbit details ---------------- */
function renderFieldNotes(){
  const section = document.getElementById('fieldNotesSection');
  const container = document.getElementById('tidbitCards');
  const banner = document.getElementById('tidbitFilterBanner');

  if(!section || !container) return;

  let list = tidbits;

  if(activeTopicFilter){

    list = list.filter(
      t => (t.topic || 'General') === activeTopicFilter
    );

    banner.innerHTML = `
      <span style="font-size:13px;color:var(--ink-soft);">
        Showing topic
        <strong>${escapeHtml(activeTopicFilter)}</strong>
        —
        <button
          class="btn-ghost btn-sm"
          id="clearTopicFilter"
          style="padding:0;"
        >
          show all
        </button>
      </span>
      ${
        isAdmin
          ? `
            <button
              class="btn-ghost btn-sm"
              id="manageTopicsLink"
              style="padding:0;"
            >
              Manage topics &amp; groups
            </button>
          `
          : ''
      }
    `;

    const clearBtn = document.getElementById('clearTopicFilter');

    if(clearBtn){
      clearBtn.onclick = ()=>{
        activeTopicFilter = null;
        renderFieldNotes();
        renderSidebarTidbits();
      };
    }

    const link = document.getElementById('manageTopicsLink');

    if(link){
      link.onclick = openTidbitTopicsModal;
    }

  } else if(isAdmin){

    banner.innerHTML = `
      <button
        class="btn-ghost btn-sm"
        id="manageTopicsLink"
        style="padding:0;"
      >
        Manage topics &amp; groups
      </button>
    `;

    const link = document.getElementById('manageTopicsLink');

    if(link){
      link.onclick = openTidbitTopicsModal;
    }

  } else {
    banner.innerHTML = '';
  }

  if(!list.length){
    section.style.display = activeTopicFilter ? 'block' : 'none';

    container.innerHTML = activeTopicFilter
      ? `
          <div class="empty-state">
            <p>No tips match this filter yet.</p>
          </div>
        `
      : '';

    return;
  }

  section.style.display = 'block';

  /* Group tidbits by topic */
  const byTopic = {};

  list.forEach(t=>{
    const key = t.topic || 'General';

    if(!byTopic[key]){
      byTopic[key] = [];
    }

    byTopic[key].push(t);
  });

  Object.values(byTopic).forEach(arr=>{
    arr.sort(
      (a,b)=>(a.position || 0) - (b.position || 0)
    );
  });

  const topicNames = Object.keys(byTopic).sort((a,b)=>{
    if(a === 'General') return 1;
    if(b === 'General') return -1;
    return a.localeCompare(b);
  });

  /* Put topics inside their assigned groups */
  const byGroup = {};

  topicNames.forEach(topic=>{
    const group = groupForTopic(topic);

    if(!byGroup[group]){
      byGroup[group] = [];
    }

    byGroup[group].push(topic);
  });

  const groupNames = orderNamesBy(Object.keys(byGroup), tidbitGroups, 'Ungrouped');

  /*
    Each group is one large card.
    Inside the group card, topics are sections and
    tidbits are clean clickable bullets.
  */
  function tidbitCardHtml(topic, items){

    const lis = items.map(t=>{

      return `
        <li
          class="tidbit-item"
          ${isAdmin ? 'draggable="true"' : ''}
          data-tidbit-id="${escapeAttr(t.id)}"
          tabindex="0"
          role="button"
          aria-label="View field note"
        >
          <span class="tidbit-bullet">•</span>

          <span class="tidbit-text">
            ${escapeHtml(t.text)}
          </span>

          ${
            isAdmin
              ? `
                <div class="tidbit-actions">
                  <button
                    class="icon-btn del"
                    data-del-tidbit="${escapeAttr(t.id)}"
                    title="Delete"
                    type="button"
                  >
                    ×
                  </button>
                </div>
              `
              : ''
          }
        </li>
      `;
    }).join('');

    return `
      <div
        class="tidbit-topic-card"
        data-topic="${escapeAttr(topic)}"
      >
        <div class="tidbit-card-header">
          <h3>${escapeHtml(topic)}</h3>
          <span class="category-count">${items.length}</span>
        </div>

        <ul class="tidbit-list">
          ${lis}
        </ul>
      </div>
    `;
  }

  /*
    Keep the original simple topic-card layout if no groups
    have been configured yet.
  */
  if(
    groupNames.length === 1 &&
    groupNames[0] === 'Ungrouped' &&
    tidbitGroups.length === 0
  ){

    container.innerHTML = `
      <div class="field-notes-group-grid">
        ${topicNames.map(topic =>
          tidbitCardHtml(topic, byTopic[topic])
        ).join('')}
      </div>
    `;

  } else {

    container.innerHTML = groupNames.map(group=>{

      const topics = byGroup[group];
      const isCollapsed = collapsedGroups.has(group);
      const tipCount = topics.reduce(
        (total, topic)=>total + byTopic[topic].length,
        0
      );

      return `
        <section
          class="tidbit-group-card${isCollapsed ? ' collapsed' : ''}"
          id="group-${escapeAttr(slugify(group))}"
        >
          <button
            type="button"
            class="tidbit-group-header"
            data-toggle-group="${escapeAttr(group)}"
            aria-expanded="${isCollapsed ? 'false' : 'true'}"
          >
            <span class="category-toggle-icon" aria-hidden="true">▾</span>
            <div>
              <h2>${escapeHtml(group)}</h2>
              <p>
                ${tipCount}
                tip${tipCount === 1 ? '' : 's'}
              </p>
            </div>
          </button>

          <div class="tidbit-topic-grid">
            ${topics.map(topic =>
              tidbitCardHtml(topic, byTopic[topic])
            ).join('')}
          </div>
        </section>
      `;

    }).join('');
  }

  container.querySelectorAll('[data-toggle-group]').forEach(btn=>{
    btn.onclick = ()=>{
      const group = btn.dataset.toggleGroup;
      const section = btn.closest('.tidbit-group-card');
      const nowCollapsed = !section.classList.contains('collapsed');
      section.classList.toggle('collapsed', nowCollapsed);
      btn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
      if(nowCollapsed) collapsedGroups.add(group); else collapsedGroups.delete(group);
      saveCollapsedGroups();
    };
  });

  /*
    Clicking a tidbit:
      - public mode = open the small details panel
      - admin mode = open the editing panel
  */
  container.querySelectorAll('.tidbit-item').forEach(li=>{

    li.addEventListener('click', e=>{

      /*
        Don't treat the delete button as clicking
        the tidbit itself.
      */
      if(e.target.closest('.tidbit-actions')){
        return;
      }

      const id = li.dataset.tidbitId;

      if(isAdmin){
        openTidbitEditModal(id);
      } else {
        openTidbitDetailsModal(id);
      }
    });

    li.addEventListener('keydown', e=>{
      if(e.key !== 'Enter' && e.key !== ' ') return;

      e.preventDefault();

      if(isAdmin){
        openTidbitEditModal(li.dataset.tidbitId);
      } else {
        openTidbitDetailsModal(li.dataset.tidbitId);
      }
    });
  });

  /* Admin drag/drop between topic cards */
  if(isAdmin){

    container.querySelectorAll('.tidbit-item').forEach(li=>{

      li.addEventListener('dragstart', e=>{
        e.dataTransfer.setData(
          'text/plain',
          li.dataset.tidbitId
        );

        li.classList.add('dragging');
      });

      li.addEventListener('dragend', ()=>{
        li.classList.remove('dragging');
      });
    });

    container.querySelectorAll('.tidbit-topic-card').forEach(card=>{

      card.addEventListener('dragover', e=>{
        e.preventDefault();
        card.classList.add('drag-over');
      });

      card.addEventListener('dragleave', ()=>{
        card.classList.remove('drag-over');
      });

      card.addEventListener('drop', async e=>{

        e.preventDefault();

        card.classList.remove('drag-over');

        const id =
          e.dataTransfer.getData('text/plain');

        const newTopic = card.dataset.topic;

        const t = tidbits.find(x=>x.id === id);

        if(!t || t.topic === newTopic){
          return;
        }

        t.topic = newTopic;

        await updateTidbitRow(id, {
          topic: newTopic,
          text: t.text,
          position: t.position
        });

        renderFieldNotes();

        showToast(`Moved to "${newTopic}"`);
      });
    });

    container.querySelectorAll('[data-del-tidbit]').forEach(btn=>{

      btn.onclick = async e=>{

        e.stopPropagation();

        const id = btn.dataset.delTidbit;

        await deleteTidbitRow(id);

        tidbits = tidbits.filter(
          t => t.id !== id
        );

        renderFieldNotes();

        showToast('Field note removed');
      };
    });
  }
}

/* ---------------- Resource field-note popup ---------------- */

function jumpToTidbit(id){
  const target = Array.from(document.querySelectorAll('.tidbit-item[data-tidbit-id]'))
    .find(item => item.dataset.tidbitId === String(id));

  if(!target){
    showToast('That field note is not visible on this page.');
    return;
  }

  const card = target.closest('.tidbit-topic-card');

  if(card){
    card.classList.add('tidbit-focus');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => card.classList.remove('tidbit-focus'), 1600);
  }

  target.focus({ preventScroll: true });
}

function openResourceTidbitsModal(resourceId){
  const res = resources.find(r => r.id === resourceId);

  if(!res) return;

  const items = tidbits
    .filter(t => t.resourceId === resourceId)
    .sort((a, b) => {
      const topicCompare = (a.topic || 'General').localeCompare(b.topic || 'General');
      if(topicCompare !== 0) return topicCompare;
      return (a.position || 0) - (b.position || 0);
    });

  if(!items.length){
    showToast('No tips were collected for this resource.');
    return;
  }

  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal tidbit-resource-modal">
        <button
          class="modal-close-x"
          id="closeX"
          type="button"
        >
          &times;
        </button>

        <h3>Tips for ${escapeHtml(res.title)}</h3>
        <p class="sub">Click a tip to jump to where it appears in the page.</p>

        <div class="tidbit-resource-list">
          ${items.map(t => `
            <button
              class="tidbit-resource-item"
              type="button"
              data-jump-tidbit="${escapeAttr(t.id)}"
            >
              <span class="tidbit-resource-topic">
                ${escapeHtml(t.topic || 'General')}
              </span>
              <span class="tidbit-resource-text">
                ${escapeHtml(t.text)}
              </span>
            </button>
          `).join('')}
        </div>

        <div class="modal-actions">
          <button
            class="btn"
            id="closeTidbitResourceList"
            type="button"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  `;

  const overlay = document.getElementById('overlay');

  overlay.onclick = e => {
    if(e.target === overlay){
      closeModal();
    }
  };

  document.getElementById('closeX').onclick = closeModal;
  document.getElementById('closeTidbitResourceList').onclick = closeModal;

  document.querySelectorAll('[data-jump-tidbit]').forEach(btn => {
    btn.onclick = () => {
      closeModal();
      jumpToTidbit(btn.dataset.jumpTidbit);
    };
  });
}

/* ---------------- Public field-note details panel ---------------- */

function openTidbitDetailsModal(id){

  const t = tidbits.find(x => x.id === id);

  if(!t) return;

  const res = resources.find(
    r => r.id === t.resourceId
  );

  const sourceHtml = res
    ? `
      <div class="tidbit-detail-source">

        <div class="tidbit-detail-label">
          Related resource
        </div>

        <h4>
          ${escapeHtml(res.title)}
        </h4>

        ${
          res.description
            ? `
              <p>
                ${escapeHtml(res.description)}
              </p>
            `
            : ''
        }

        ${
          res.url
            ? `
              <a
                href="${escapeAttr(res.url)}"
                target="_blank"
                rel="noopener"
                class="tidbit-detail-link"
              >
                Open resource ↗
              </a>
            `
            : ''
        }

      </div>
    `
    : `
      <div class="tidbit-detail-source">

        <div class="tidbit-detail-label">
          Related resource
        </div>

        <p class="tidbit-no-source">
          No related resource.
        </p>

      </div>
    `;

  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">

      <div class="modal tidbit-detail-modal">

        <button
          class="modal-close-x"
          id="closeX"
          type="button"
        >
          &times;
        </button>

        <div class="tidbit-detail-topic">
          ${escapeHtml(t.topic || 'General')}
        </div>

        <div class="tidbit-detail-text">
          ${escapeHtml(t.text)}
        </div>

        ${sourceHtml}

        <div class="modal-actions">
          <button
            class="btn"
            id="closeTidbitDetails"
            type="button"
          >
            Close
          </button>
        </div>

      </div>

    </div>
  `;

  const overlay = document.getElementById('overlay');

  overlay.onclick = e=>{
    if(e.target === overlay){
      closeModal();
    }
  };

  document.getElementById('closeX').onclick =
    closeModal;

  document.getElementById('closeTidbitDetails').onclick =
    closeModal;
}

/* ---------------- Edit a single tidbit (text + which resource it's linked to) ---------------- */
function openTidbitEditModal(id){
  const t = tidbits.find(x=>x.id===id);
  if(!t) return;
  const resourceOptions = [...resources].sort((a,b)=> a.title.localeCompare(b.title));

  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <button class="modal-close-x" id="closeX">&times;</button>
        <h3>Edit tip</h3>
        <p class="sub">Topic: <strong>${escapeHtml(t.topic || 'General')}</strong> — to move it to a different topic, drag it between cards instead.</p>

        <div class="field">
          <label for="tbText">Text</label>
          <textarea id="tbText" style="min-height:80px;">${escapeHtml(t.text)}</textarea>
        </div>

        <div class="field">
          <label for="tbResource">Related resource</label>
          <select id="tbResource">
            <option value="">No source</option>
            ${resourceOptions.map(r=>`<option value="${escapeAttr(r.id)}" ${r.id===t.resourceId?'selected':''}>${escapeHtml(r.title)}</option>`).join('')}
          </select>
        </div>

        <div class="modal-actions">
          <button class="btn" id="cancelTbEdit">Cancel</button>
          <button class="btn btn-primary" id="saveTbEdit">Save changes</button>
        </div>
      </div>
    </div>`;

  const overlay = document.getElementById('overlay');
  overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
  document.getElementById('closeX').onclick = closeModal;
  document.getElementById('cancelTbEdit').onclick = closeModal;
  document.getElementById('saveTbEdit').onclick = async ()=>{
    const newText = document.getElementById('tbText').value.trim();
    const newResourceId = document.getElementById('tbResource').value || null;
    if(!newText){ showToast('Tip text can\'t be empty'); return; }
    const ok = await updateTidbitRow(id, { topic: t.topic, text: newText, position: t.position, resourceId: newResourceId });
    if(CONFIGURED && !ok) return;
    t.text = newText;
    t.resourceId = newResourceId;
    closeModal();
    renderFieldNotes();
    renderMain();
    showToast('Tip updated');
  };
}

/* ---------------- Delete a resource, with cascade options for its field notes ---------------- */
function confirmDelete(id, btn){
  openDeleteResourceModal(id);
}

function openDeleteResourceModal(id){
  const r = resources.find(x=>x.id===id);
  if(!r) return;
  const related = tidbits.filter(t => t.resourceId === id);

  const checklistRows = related.map(t=>`
    <label class="tag-item" style="cursor:pointer;">
      <input type="checkbox" class="del-tb-check" data-tb-id="${t.id}" checked style="margin-right:8px;">
      <span style="flex:1;">${escapeHtml(t.text)} <span class="count">(${escapeHtml(t.topic || 'General')})</span></span>
    </label>`).join('');

  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <button class="modal-close-x" id="closeX">&times;</button>
        <h3>Delete "${escapeHtml(r.title)}"?</h3>
        <p class="sub">This can't be undone.</p>

        ${related.length ? `
          <p style="font-size:14px;color:var(--ink);margin:0 0 10px;">This resource has ${related.length} tip${related.length===1?'':'s'}. What should happen to ${related.length===1?'it':'them'}?</p>

          <div class="field">
            <label style="display:flex;align-items:center;gap:8px;font-weight:400;">
              <input type="radio" name="cascadeMode" value="all" checked> Delete all ${related.length===1?'it':'them'} along with the resource
            </label>
            <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin-top:6px;">
              <input type="radio" name="cascadeMode" value="pick"> Let me choose which to delete
            </label>
            <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin-top:6px;">
              <input type="radio" name="cascadeMode" value="keep"> Keep them all — unlink instead of deleting
            </label>
          </div>

          <div class="field" id="cascadeChecklist" style="display:none;max-height:220px;overflow-y:auto;">
            ${checklistRows}
          </div>
        ` : `<p style="font-size:14px;color:var(--ink-soft);">It has no tips attached.</p>`}

        <div class="modal-actions">
          <button class="btn" id="cancelDelete">Cancel</button>
          <button class="btn btn-danger" id="confirmDeleteBtn">Delete resource</button>
        </div>
      </div>
    </div>`;

  const overlay = document.getElementById('overlay');
  overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
  document.getElementById('closeX').onclick = closeModal;
  document.getElementById('cancelDelete').onclick = closeModal;

  const checklistEl = document.getElementById('cascadeChecklist');
  document.querySelectorAll('input[name=cascadeMode]').forEach(radio=>{
    radio.onchange = ()=>{
      if(checklistEl) checklistEl.style.display = radio.value === 'pick' && radio.checked ? 'block' : 'none';
    };
  });

  document.getElementById('confirmDeleteBtn').onclick = async ()=>{
    const modeEl = document.querySelector('input[name=cascadeMode]:checked');
    const mode = modeEl ? modeEl.value : 'all';

    let idsToDelete = [];
    let idsToUnlink = [];
    if(mode === 'all'){
      idsToDelete = related.map(t=>t.id);
    } else if(mode === 'pick'){
      document.querySelectorAll('.del-tb-check').forEach(cb=>{
        if(cb.checked) idsToDelete.push(cb.dataset.tbId); else idsToUnlink.push(cb.dataset.tbId);
      });
    } else if(mode === 'keep'){
      idsToUnlink = related.map(t=>t.id);
    }

    if(CONFIGURED){
      for(const tid of idsToDelete) await deleteTidbitRow(tid);
      for(const tid of idsToUnlink){
        const t = tidbits.find(x=>x.id===tid);
        if(t) await updateTidbitRow(tid, { topic: t.topic, text: t.text, position: t.position, resourceId: null });
      }
      const ok = await deleteResourceRow(id);
      if(!ok) return;
    }

    tidbits = tidbits.filter(t => !idsToDelete.includes(t.id));
    tidbits.forEach(t => { if(idsToUnlink.includes(t.id)) t.resourceId = null; });
    resources = resources.filter(x=>x.id!==id);

    closeModal();
    renderAll();
    const extra = idsToDelete.length ? `, ${idsToDelete.length} tip${idsToDelete.length===1?'':'s'} removed` : (idsToUnlink.length ? `, ${idsToUnlink.length} tip${idsToUnlink.length===1?'':'s'} kept` : '');
    showToast(`Deleted "${r.title}"${extra}`);
  };
}

/* ---------------- Modals ---------------- */
function closeModal(){ document.getElementById('modalRoot').innerHTML = ''; }

function openAppDetailModal(id){
  const r = resources.find(x=>x.id===id);
  if(!r) return;
  const screenshots = r.screenshots || [];
  const chips = (r.tags||[]).map(t=>`<span class="chip" data-chip="${escapeAttr(t)}">${escapeHtml(t)}</span>`).join('');
  const storeUrl = r.appStoreUrl || r.url;
  const tidbitCount = tidbits.filter(t=>t.resourceId===r.id).length;

  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal app-modal">
        <button class="modal-close-x" id="closeX">&times;</button>
        <div class="app-modal-header">
          ${r.iconUrl ? `<img class="app-modal-icon" src="${escapeAttr(r.iconUrl)}" alt="">` : ''}
          <div>
            <h3 style="margin-bottom:2px;">${escapeHtml(r.title)}</h3>
            <span class="type-badge">App</span>
          </div>
        </div>
        ${screenshots.length
          ? `<div class="screenshot-strip">${screenshots.map(s=>`<img src="${escapeAttr(s)}" alt="Screenshot" loading="lazy">`).join('')}</div>`
          : `<p style="font-size:13px;color:var(--ink-faint);">No screenshots added yet.</p>`}
        <p class="card-desc" style="margin:12px 0;">${escapeHtml(r.description)}</p>
        <div class="tag-chips" style="margin-bottom:14px;">${chips}</div>
        <div class="modal-actions" style="justify-content:space-between;align-items:center;">
          <div>${tidbitCount ? `<button class="btn btn-sm" id="viewAppTidbits">${tidbitCount} tip${tidbitCount===1?'':'s'}</button>` : ''}</div>
          <div style="display:flex;gap:10px;">
            ${storeUrl ? `<a class="btn btn-accent" href="${escapeAttr(storeUrl)}" target="_blank" rel="noopener">Open in App Store ↗</a>` : ''}
            <button class="btn" id="closeAppModal">Close</button>
          </div>
        </div>
        ${isAdmin ? `<div class="card-admin-actions" style="margin-top:12px;">
          <button class="icon-btn" id="editAppFromModal">Edit</button>
          <button class="icon-btn del" id="deleteAppFromModal">Delete</button>
        </div>` : ''}
      </div>
    </div>`;

  const overlay = document.getElementById('overlay');
  overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
  document.getElementById('closeX').onclick = closeModal;
  document.getElementById('closeAppModal').onclick = closeModal;
  document.querySelectorAll('#modalRoot [data-chip]').forEach(chip=>{
    chip.onclick = ()=>{ closeModal(); activeTag = chip.dataset.chip; renderAll(); };
  });
  const viewTb = document.getElementById('viewAppTidbits');
  if(viewTb) viewTb.onclick = ()=> openResourceTidbitsModal(r.id);
  if(isAdmin){
    document.getElementById('editAppFromModal').onclick = ()=> openResourceModal(r.id);
    document.getElementById('deleteAppFromModal').onclick = ()=> openDeleteResourceModal(r.id);
  }
}

function openLoginModal(){
  if(!CONFIGURED){
    showToast('Connect Supabase first — see the banner at the top.');
    return;
  }
  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <button class="modal-close-x" id="closeX">&times;</button>
        <h3>Admin login</h3>
        <p class="sub">Sign in with the admin account to add, edit, or remove resources.</p>
        <div class="modal-error" id="loginError" style="display:none;"></div>
        <div class="field">
          <label for="emailInput">Email</label>
          <input type="text" id="emailInput" autocomplete="username">
        </div>
        <div class="field">
          <label for="pwInput">Password</label>
          <input type="password" id="pwInput" autocomplete="current-password">
        </div>
        <div class="modal-actions">
          <button class="btn" id="cancelLogin">Cancel</button>
          <button class="btn btn-primary" id="submitLogin">Log in</button>
        </div>
      </div>
    </div>`;
  const overlay = document.getElementById('overlay');
  overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
  document.getElementById('closeX').onclick = closeModal;
  document.getElementById('cancelLogin').onclick = closeModal;
  const emailInput = document.getElementById('emailInput');
  const pwInput = document.getElementById('pwInput');
  emailInput.focus();
  const submit = async ()=>{
    const errMsg = await loginWithPassword(emailInput.value.trim(), pwInput.value);
    if(!errMsg){
      isAdmin = true;
      resources = await loadResources();
      closeModal();
      renderHeaderActions();
      renderAll();
      showToast('Logged in as admin');
    } else {
      const err = document.getElementById('loginError');
      err.textContent = errMsg;
      err.style.display = 'block';
    }
  };
  document.getElementById('submitLogin').onclick = submit;
  pwInput.addEventListener('keydown', e=>{ if(e.key==='Enter') submit(); });
}

function openResourceModal(id){
  editingId = id;
  const existing = id ? resources.find(r=>r.id===id) : null;
  const title = existing ? existing.title : '';
  const description = existing ? existing.description : '';
  const url = existing ? existing.url : '';
  const type = existing ? existing.type : 'link';
  const tags = existing ? (existing.tags||[]).join(', ') : '';
  const existingSourceText = existing ? (existing.sourceText || '') : '';
  const rawCategory = existing ? (existing.category || '') : '';
  const category = rawCategory === 'Uncategorized' ? '' : rawCategory;
  const categoryOptions = [...categories];
  if(category && !categoryOptions.includes(category)) categoryOptions.push(category);
  categoryOptions.sort((a,b)=> a.localeCompare(b));

  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <button class="modal-close-x" id="closeX">&times;</button>
        <h3>${existing ? 'Edit resource' : 'Add resource'}</h3>
        <p class="sub">${existing ? 'Update the details below.' : 'Fill in what you have — tags are suggested automatically.'}</p>

        <div class="field">
          <label for="fTitle">Title</label>
          <input type="text" id="fTitle" value="${escapeAttr(title)}" placeholder="e.g. Laser Cutter Booking">
        </div>

        <div class="field">
          <label>Type</label>
          <div class="type-toggle">
            <label><input type="radio" name="ftype" value="link" ${type==='link'?'checked':''}><span>Link</span></label>
            <label><input type="radio" name="ftype" value="file" ${type==='file'?'checked':''}><span>File</span></label>
            <label><input type="radio" name="ftype" value="info" ${type==='info'?'checked':''}><span>No link</span></label>
            <label><input type="radio" name="ftype" value="app" ${type==='app'?'checked':''}><span>App</span></label>
          </div>
        </div>

        <div class="field" id="urlField" style="display:${type==='info' ? 'none':'block'};">
          <label for="fUrl" id="fUrlLabel">${type==='app' ? 'App Store / Play Store link' : 'URL'}</label>
          <input type="url" id="fUrl" value="${escapeAttr(url)}" placeholder="https://…">
          <div class="ai-status-row">
            <div id="aiStatus" style="font-size:12.5px;color:var(--ink-faint);margin-top:6px;min-height:16px;"></div>
            <button type="button" class="btn-ghost btn-sm" id="aiRetryBtn" style="display:none;">Try again</button>
          </div>
          <button type="button" class="btn-ghost btn-sm" id="pasteToggle" style="display:none;padding:2px 0;">Paste page text instead</button>
          <div id="pasteBox" style="display:none;margin-top:8px;">
            <textarea id="pastedText" placeholder="Select all the text on the page (Ctrl/Cmd+A, then Ctrl/Cmd+C) and paste it here — useful for pages that block automatic fetching or need JavaScript to load." style="min-height:90px;"></textarea>
            <button type="button" class="btn btn-sm" id="analyzePasted" style="margin-top:6px;">Analyze pasted text</button>
          </div>
        </div>

        <div class="field" id="appFetchField" style="display:${type==='app' ? 'block':'none'};">
          <label>App Store info</label>
          <div class="app-fetch-row">
            <button type="button" class="btn btn-sm" id="fetchAppBtn">Fetch from App Store</button>
            <span class="app-fetch-status" id="appFetchStatus"></span>
            <button type="button" class="btn-ghost btn-sm" id="appFetchRetryBtn" style="display:none;">Try again</button>
          </div>
          <p style="font-size:12px;color:var(--ink-faint);margin:6px 0 0;">Paste the App Store link above (or just type the app's name) and click fetch — it pulls the icon, screenshots, and description automatically. There's no public API for Google Play, so for Android apps add screenshot image URLs manually below.</p>
          <input type="hidden" id="fIcon" value="${escapeAttr(existing ? (existing.iconUrl||'') : '')}">
          <img id="fIconPreview" class="app-icon-preview" src="${escapeAttr(existing ? (existing.iconUrl||'') : '')}" style="display:${existing && existing.iconUrl ? 'block':'none'};" alt="">
          <label for="fScreenshots" style="margin-top:10px;">Screenshots (one image URL per line)</label>
          <textarea id="fScreenshots" placeholder="https://…">${existing ? (existing.screenshots||[]).join('\n') : ''}</textarea>
        </div>

        <div class="field">
          <label for="fCategory">Category</label>
          <select id="fCategory">
            <option value="" ${category===''?'selected':''}>Uncategorized</option>
            ${categoryOptions.map(c=>`<option value="${escapeAttr(c)}" ${c===category?'selected':''}>${escapeHtml(c)}</option>`).join('')}
            <option value="__new__">+ Add new category…</option>
          </select>
          <input type="text" id="fNewCategory" placeholder="New category name" style="display:none;margin-top:8px;">
        </div>

        <div class="field">
          <div class="tag-suggest-row">
            <label style="margin-bottom:0;" for="fDesc">Description</label>
            <button class="btn btn-sm" id="regenDesc" type="button">Suggest description</button>
          </div>
          <textarea id="fDesc" placeholder="What is it, and anything students should know before clicking (e.g. sign-in required)?">${escapeHtml(description)}</textarea>
        </div>

        <div class="field">
          <div class="tag-suggest-row">
            <label style="margin-bottom:0;" for="fTags">Tags</label>
            <button class="btn btn-sm" id="regenTags" type="button">Suggest tags</button>
          </div>
          <input type="text" id="fTags" value="${escapeAttr(tags)}" placeholder="comma, separated, tags">
        </div>

        <div class="field" id="tidbitPromptField" style="display:none;">
          <div class="tag-suggest-row">
            <label style="margin-bottom:0;">Tips &amp; AI fill-in</label>
            <button class="btn btn-sm" id="copyResourcePromptBtn" type="button">Copy AI prompt</button>
          </div>
          <p style="font-size:12.5px;color:var(--ink-faint);margin:2px 0 8px;">Paste this into any chatbot (Claude, ChatGPT…), then paste its reply below — it fills in the fields above and stages tips together, in one round-trip.</p>
          <textarea id="resourcePasteReply" placeholder="Paste the chatbot's reply here…" style="min-height:80px;"></textarea>
          <div style="margin-top:6px;">
            <button class="btn btn-sm" id="processResourceReplyBtn" type="button">Process reply</button>
            <span id="resourceReplyStatus" style="font-size:12.5px;color:var(--ink-faint);margin-left:8px;"></span>
          </div>
          <div id="resourceTidbitReview" style="margin-top:10px;"></div>
        </div>

        <div class="modal-actions">
          <button class="btn" id="cancelResource">Cancel</button>
          <button class="btn btn-primary" id="saveResource">${existing ? 'Save changes' : 'Add resource'}</button>
        </div>
      </div>
    </div>`;

  const overlay = document.getElementById('overlay');
  overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
  document.getElementById('closeX').onclick = closeModal;
  document.getElementById('cancelResource').onclick = closeModal;

  document.querySelectorAll('input[name=ftype]').forEach(r=>{
    r.onchange = ()=>{
      document.getElementById('urlField').style.display = r.value === 'info' ? 'none' : 'block';
      document.getElementById('appFetchField').style.display = r.value === 'app' ? 'block' : 'none';
      document.getElementById('fUrlLabel').textContent = r.value === 'app' ? 'App Store / Play Store link' : 'URL';
      refreshAutoDescription();
    };
  });

  const fetchAppBtn = document.getElementById('fetchAppBtn');
  const appFetchRetryBtn = document.getElementById('appFetchRetryBtn');
  if(fetchAppBtn){
    const runAppFetch = async ()=>{
      const status = document.getElementById('appFetchStatus');
      appFetchRetryBtn.style.display = 'none';
      const q = document.getElementById('fUrl').value.trim() || document.getElementById('fTitle').value.trim();
      if(!q){ status.textContent = 'Enter a URL or app name above first.'; return; }
      status.textContent = 'Looking up…';
      const result = await fetchAppStoreInfo(q);
      if(!result || result.error){
        status.textContent = (result && result.error) || 'Lookup failed.';
        appFetchRetryBtn.style.display = 'inline-block';
        return;
      }
      const fTitle = document.getElementById('fTitle');
      const fDesc = document.getElementById('fDesc');
      if(!fTitle.value.trim() && result.title) fTitle.value = result.title;
      if(!descTouched && result.description){ fDesc.value = result.description; }
      if(result.appStoreUrl) document.getElementById('fUrl').value = result.appStoreUrl;
      document.getElementById('fIcon').value = result.icon || '';
      const preview = document.getElementById('fIconPreview');
      if(result.icon){ preview.src = result.icon; preview.style.display = 'block'; }
      if(result.screenshots && result.screenshots.length){
        document.getElementById('fScreenshots').value = result.screenshots.join('\n');
      }
      status.textContent = `✓ Found "${result.title}"`;
    };
    fetchAppBtn.onclick = runAppFetch;
    appFetchRetryBtn.onclick = runAppFetch;
  }

  const fCategoryEl = document.getElementById('fCategory');
  const fNewCategoryEl = document.getElementById('fNewCategory');
  fCategoryEl.onchange = ()=>{
    fNewCategoryEl.style.display = fCategoryEl.value === '__new__' ? 'block' : 'none';
    if(fCategoryEl.value === '__new__') fNewCategoryEl.focus();
  };

  // Auto-generate the description from title/type/URL, but stop the moment
  // the person types into the description box themselves — it stays theirs
  // to edit from then on unless they click "Suggest description" again.
  const fTitleEl = document.getElementById('fTitle');
  const fUrlEl = document.getElementById('fUrl');
  const fDescEl = document.getElementById('fDesc');
  let descTouched = !!description;

  function refreshAutoDescription(){
    if(descTouched) return;
    const ty = document.querySelector('input[name=ftype]:checked').value;
    fDescEl.value = autoDescription(fTitleEl.value, ty, fUrlEl.value);
  }

  fTitleEl.addEventListener('input', refreshAutoDescription);
  fUrlEl.addEventListener('input', refreshAutoDescription);
  fDescEl.addEventListener('input', ()=>{ descTouched = true; });

  document.getElementById('regenDesc').onclick = ()=>{
    const ty = document.querySelector('input[name=ftype]:checked').value;
    fDescEl.value = autoDescription(fTitleEl.value, ty, fUrlEl.value);
    descTouched = false;
  };

  // ---- AI autofill: runs automatically once a real URL is entered, no button needed ----
  const fTagsEl = document.getElementById('fTags');
  const fCategoryEl2 = document.getElementById('fCategory');
  const fNewCategoryEl2 = document.getElementById('fNewCategory');
  const aiStatusEl = document.getElementById('aiStatus');
  const aiRetryBtn = document.getElementById('aiRetryBtn');
  const pasteToggleEl = document.getElementById('pasteToggle');
  const pasteBoxEl = document.getElementById('pasteBox');
  const pastedTextEl = document.getElementById('pastedText');
  let lastAutofilledUrl = '';
  let autofillInFlight = false;
  let lastAutofillRetry = null; // zero-arg fn that repeats whatever last failed

  function hideAutofillRetry(){
    aiRetryBtn.style.display = 'none';
    lastAutofillRetry = null;
  }
  function offerAutofillRetry(retryFn){
    lastAutofillRetry = retryFn;
    aiRetryBtn.style.display = 'inline-block';
  }
  aiRetryBtn.onclick = ()=>{
    if(!lastAutofillRetry || autofillInFlight) return;
    const retryFn = lastAutofillRetry;
    hideAutofillRetry();
    retryFn();
  };

  // Applies an AI result to the form. Only fills fields that are still
  // empty at the moment it runs — checked live, not via a stale "touched"
  // flag — so it never clobbers anything you've already typed.
  function applyAutofillResult(result){
    if(!fTitleEl.value.trim() && result.title) fTitleEl.value = result.title;
    if(!descTouched && result.description){ fDescEl.value = result.description; descTouched = true; }
    if(!fTagsEl.value.trim() && Array.isArray(result.tags) && result.tags.length) fTagsEl.value = result.tags.join(', ');
    if(fCategoryEl2.value === '' && result.category){
      const match = categories.find(c => c.toLowerCase() === result.category.toLowerCase());
      if(match){
        fCategoryEl2.value = match;
      } else {
        fCategoryEl2.value = '__new__';
        fNewCategoryEl2.style.display = 'block';
        fNewCategoryEl2.value = result.category;
      }
    }
  }

  // Model-overload errors (503s, "high demand") are usually gone within a
  // few seconds, so it's worth one silent automatic retry before bothering
  // the admin — anything else (bad key, bad URL, etc.) fails straight away
  // and falls through to the manual "Try again" button instead.
  function isTransientAiError(status, message){
    return status === 503 || /overloaded|high demand|try again later/i.test(message || '');
  }

  async function callAutofillEndpoint(payload, statusEl){
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const token = sessionData && sessionData.session ? sessionData.session.access_token : null;
    if(!token){ statusEl.textContent = ''; return null; }

    for(let attempt = 0; attempt < 2; attempt++){
      let res;
      try{
        res = await fetch(AUTOFILL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(payload)
        });
      } catch(e){
        statusEl.textContent = "Couldn't reach the autofill function — check it's deployed in Supabase.";
        return null;
      }

      let result;
      try{
        result = await res.json();
      } catch(e){
        statusEl.textContent = `Autofill function returned an unexpected response (status ${res.status}) — make sure the latest function code is deployed.`;
        return null;
      }

      if(!res.ok || result.error){
        if(attempt === 0 && isTransientAiError(res.status, result.error)){
          statusEl.textContent = '⏳ Model is busy — retrying automatically…';
          await new Promise(r => setTimeout(r, 2500));
          continue;
        }
        statusEl.textContent = result.error ? `Couldn't auto-fill: ${result.error}` : "Couldn't auto-fill.";
        return null;
      }
      return result;
    }
    return null;
  }

  async function maybeRunAutofill(force){
    const rawUrl = fUrlEl.value.trim();
    if(!AUTOFILL_URL) return; // Supabase/Edge Function not set up yet
    if(!/^https?:\/\//i.test(rawUrl)) return;
    if(!force && (rawUrl === lastAutofilledUrl || autofillInFlight)) return;
    lastAutofilledUrl = rawUrl;
    autofillInFlight = true;
    hideAutofillRetry();
    aiStatusEl.textContent = '✨ Analyzing page…';
    try{
      const result = await callAutofillEndpoint({ url: rawUrl, categories }, aiStatusEl);
      if(result){
        applyAutofillResult(result);
        aiStatusEl.textContent = '✓ Filled in from the page — review before saving';
      } else {
        offerAutofillRetry(()=> maybeRunAutofill(true));
      }
    } catch(e){
      aiStatusEl.textContent = "Couldn't auto-fill — fill in manually, or paste the page text below.";
      offerAutofillRetry(()=> maybeRunAutofill(true));
    }
    autofillInFlight = false;
  }

  fUrlEl.addEventListener('blur', ()=> maybeRunAutofill(false));
  fUrlEl.addEventListener('paste', ()=> setTimeout(()=> maybeRunAutofill(false), 50));

  // ---- Manual fallback: some sites block automated fetches or need JS to
  // render (so the server-side fetch sees a near-empty page). Letting the
  // admin paste the page's visible text sidesteps that entirely. The pasted
  // text itself is kept with the resource so it never needs re-pasting.
  let sourceText = existingSourceText;
  if(AUTOFILL_URL){
    pasteToggleEl.style.display = 'inline-block';
    if(sourceText){
      pastedTextEl.value = sourceText;
      pasteToggleEl.textContent = 'View/edit saved page text';
    }
    pasteToggleEl.onclick = ()=>{
      const showing = pasteBoxEl.style.display !== 'none';
      pasteBoxEl.style.display = showing ? 'none' : 'block';
      pasteToggleEl.textContent = showing ? (sourceText ? 'View/edit saved page text' : 'Paste page text instead') : 'Hide';
      if(!showing) pastedTextEl.focus();
    };
    pastedTextEl.addEventListener('input', ()=>{ sourceText = pastedTextEl.value; });

    async function runPastedAnalysis(text){
      if(autofillInFlight) return;
      autofillInFlight = true;
      hideAutofillRetry();
      aiStatusEl.textContent = '✨ Analyzing pasted text…';
      try{
        const result = await callAutofillEndpoint({ url: fUrlEl.value.trim(), categories, pastedText: text }, aiStatusEl);
        if(result){
          applyAutofillResult(result);
          sourceText = text;
          aiStatusEl.textContent = '✓ Filled in from your pasted text — review before saving (text saved with this resource)';
          pasteBoxEl.style.display = 'none';
          pasteToggleEl.textContent = 'View/edit saved page text';
        } else {
          offerAutofillRetry(()=> runPastedAnalysis(text));
        }
      } catch(e){
        aiStatusEl.textContent = "Couldn't analyze that text — fill in manually.";
        offerAutofillRetry(()=> runPastedAnalysis(text));
      }
      autofillInFlight = false;
    }

    document.getElementById('analyzePasted').onclick = ()=>{
      const text = pastedTextEl.value.trim();
      if(!text){ aiStatusEl.textContent = 'Paste some text first.'; hideAutofillRetry(); return; }
      runPastedAnalysis(text);
    };
  }

  document.getElementById('regenTags').onclick = ()=>{
    const t = document.getElementById('fTitle').value;
    const d = document.getElementById('fDesc').value;
    const ty = document.querySelector('input[name=ftype]:checked').value;
    document.getElementById('fTags').value = autoTags(t,d,ty).join(', ');
  };

  // ---- Combined AI round-trip: one copyable prompt covers resource fields
  // AND field notes together. Paste the reply back here and both fill in at
  // once — nothing saves to Supabase until "Add resource"/"Save changes" is
  // clicked, at which point any staged field notes save alongside it.
  let pendingTidbits = []; // [{ topic, tidbits: [string] }] staged to save with this resource
  const tidbitPromptFieldEl = document.getElementById('tidbitPromptField');
  if(AUTOFILL_URL){
    tidbitPromptFieldEl.style.display = 'block';

    document.getElementById('copyResourcePromptBtn').onclick = async ()=>{
      const draft = { title: fTitleEl.value.trim(), url: fUrlEl.value.trim(), sourceText };
      const prompt = buildCombinedPrompt(draft, categories, tidbitTopics);
      const status = document.getElementById('resourceReplyStatus');
      try{
        await navigator.clipboard.writeText(prompt);
        status.textContent = '✓ Copied — paste it into your chatbot of choice';
      } catch(e){
        status.textContent = "Couldn't copy automatically — it's in the paste box below, select and copy manually.";
        document.getElementById('resourcePasteReply').value = prompt;
      }
    };

    document.getElementById('processResourceReplyBtn').onclick = async ()=>{
      const text = document.getElementById('resourcePasteReply').value.trim();
      const status = document.getElementById('resourceReplyStatus');
      if(!text){ status.textContent = 'Paste the chatbot reply first.'; return; }
      status.textContent = '✨ Parsing…';
      const result = await callAutofillEndpoint({ action: 'parse_all', pastedText: text, categories, topics: tidbitTopics }, status);
      if(result){
        applyAutofillResult(result);
        pendingTidbits = Array.isArray(result.tidbits) ? result.tidbits.filter(tg => tg && Array.isArray(tg.tidbits) && tg.tidbits.length) : [];
        status.textContent = pendingTidbits.length
          ? `✓ Filled in the fields above — review the ${pendingTidbits.length} tip group${pendingTidbits.length===1?'':'s'} below before saving`
          : '✓ Filled in the fields above — no tips found in that text.';
        renderPendingTidbitReview();
      }
    };
  }

  function renderPendingTidbitReview(){
    const area = document.getElementById('resourceTidbitReview');
    if(!pendingTidbits.length){ area.innerHTML = ''; return; }
    area.innerHTML = pendingTidbits.map((tg, ti)=>`
      <div class="field" data-review-topic="${ti}">
        <input type="text" class="review-topic-name" data-ti="${ti}" value="${escapeAttr(tg.topic)}" style="font-weight:600;margin-bottom:8px;">
        ${tg.tidbits.map((tb, bi)=>`
          <div style="display:flex;gap:6px;margin-bottom:6px;align-items:flex-start;">
            <textarea class="review-tidbit-text" data-ti="${ti}" data-bi="${bi}" style="flex:1;min-height:44px;font-size:13.5px;">${escapeHtml(tb)}</textarea>
            <button class="icon-btn del" data-remove-tidbit data-ti="${ti}" data-bi="${bi}" title="Remove">×</button>
          </div>
        `).join('')}
        <button class="btn-ghost btn-sm" data-add-tidbit data-ti="${ti}" style="padding:2px 0;">+ Add bullet to this card</button>
      </div>
    `).join('');

    area.querySelectorAll('.review-topic-name').forEach(inp=>{
      inp.addEventListener('input', ()=>{ pendingTidbits[Number(inp.dataset.ti)].topic = inp.value; });
    });
    area.querySelectorAll('.review-tidbit-text').forEach(ta=>{
      ta.addEventListener('input', ()=>{ pendingTidbits[Number(ta.dataset.ti)].tidbits[Number(ta.dataset.bi)] = ta.value; });
    });
    area.querySelectorAll('[data-remove-tidbit]').forEach(btn=>{
      btn.onclick = ()=>{
        pendingTidbits[Number(btn.dataset.ti)].tidbits.splice(Number(btn.dataset.bi), 1);
        renderPendingTidbitReview();
      };
    });
    area.querySelectorAll('[data-add-tidbit]').forEach(btn=>{
      btn.onclick = ()=>{
        pendingTidbits[Number(btn.dataset.ti)].tidbits.push('');
        renderPendingTidbitReview();
      };
    });
  }

  document.getElementById('saveResource').onclick = async ()=>{
    const t = document.getElementById('fTitle').value.trim();
    const d = document.getElementById('fDesc').value.trim();
    const ty = document.querySelector('input[name=ftype]:checked').value;
    const u = document.getElementById('fUrl').value.trim();
    let tagList = document.getElementById('fTags').value.split(',').map(s=>s.trim()).filter(Boolean);
    if(!t){
      alertField('fTitle', 'Give the resource a title.');
      return;
    }
    if(tagList.length === 0){
      tagList = autoTags(t,d,ty);
    }
    let cat = document.getElementById('fCategory').value;
    if(cat === '__new__'){
      const newName = document.getElementById('fNewCategory').value.trim();
      if(!newName){
        alertField('fNewCategory', 'Type a name for the new category, or pick an existing one.');
        return;
      }
      const existingMatch = categories.find(c => c.toLowerCase() === newName.toLowerCase());
      if(existingMatch){
        cat = existingMatch;
      } else {
        const added = await addCategory(newName);
        if(!added) return;
        cat = newName;
      }
    }
    const fIconEl = document.getElementById('fIcon');
    const fScreenshotsEl = document.getElementById('fScreenshots');
    const iconUrl = ty==='app' && fIconEl ? fIconEl.value.trim() : '';
    const screenshotsList = ty==='app' && fScreenshotsEl
      ? fScreenshotsEl.value.split('\n').map(s=>s.trim()).filter(Boolean)
      : [];
    const payload = {
      title: t, description: d, type: ty, url: ty==='info' ? '' : u, category: cat, tags: tagList, sourceText: sourceText || '',
      iconUrl, appStoreUrl: ty==='app' ? u : '', screenshots: screenshotsList
    };

    let resourceId;
    if(existing){
      if(CONFIGURED){
        const ok = await updateResourceRow(existing.id, payload);
        if(!ok) return;
      }
      Object.assign(existing, payload);
      resourceId = existing.id;
    } else {
      if(CONFIGURED){
        const created = await insertResource(payload);
        if(!created) return;
        resources.push(created);
        resourceId = created.id;
      } else {
        const newRes = { id: 'r' + Date.now(), ...payload, addedAt: Date.now() };
        resources.push(newRes);
        resourceId = newRes.id;
      }
    }

    // Save any field notes staged via the combined AI round-trip above,
    // now that the resource has an id to attach them to.
    let notesAdded = 0;
    for(const tg of pendingTidbits){
      let topicName = (tg.topic || 'General').trim() || 'General';
      if(topicName.toLowerCase() !== 'general'){
        const match = tidbitTopics.find(t=>t.toLowerCase()===topicName.toLowerCase());
        if(match){ topicName = match; }
        else { await addTidbitTopic(topicName); }
      }
      let pos = tidbits.filter(t=>t.topic===topicName).length;
      for(const text of tg.tidbits){
        const clean = (text||'').trim();
        if(!clean) continue;
        const saved = await insertTidbit({ resourceId, topic: topicName, text: clean, position: pos++ });
        if(saved){ tidbits.push(saved); notesAdded++; }
      }
    }

    closeModal();
    renderAll();
    const baseMsg = existing ? 'Changes saved' : 'Resource added';
    showToast(notesAdded ? `${baseMsg} — plus ${notesAdded} tip${notesAdded===1?'':'s'}` : baseMsg);
  };
}

function alertField(fieldId, msg){
  const f = document.getElementById(fieldId);
  f.style.outline = '2px solid var(--danger)';
  f.focus();
  setTimeout(()=>{ f.style.outline=''; }, 1800);
  showToast(msg);
}

function openSettingsModal(){
  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <button class="modal-close-x" id="closeX">&times;</button>
        <h3>Site settings</h3>
        <p class="sub">Change what visitors see. Admin accounts are managed in your Supabase project under Authentication.</p>

        <div class="field">
          <label for="sTitle">Short description</label>
          <input type="text" id="sTitle" value="${escapeAttr(settings.title)}">
        </div>
        <div class="field">
          <label for="sSub">Sidebar text</label>
          <input type="text" id="sSub" value="${escapeAttr(settings.subtitle)}">
        </div>

        <div class="modal-actions">
          <button class="btn" id="cancelSettings">Cancel</button>
          <button class="btn btn-primary" id="saveSettings">Save settings</button>
        </div>
      </div>
    </div>`;
  const overlay = document.getElementById('overlay');
  overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
  document.getElementById('closeX').onclick = closeModal;
  document.getElementById('cancelSettings').onclick = closeModal;
  document.getElementById('saveSettings').onclick = async ()=>{
    const newSettings = {
      title: document.getElementById('sTitle').value.trim() || DEFAULT_SETTINGS.title,
      subtitle: document.getElementById('sSub').value.trim() || DEFAULT_SETTINGS.subtitle
    };
    if(CONFIGURED){
      const ok = await saveSettingsRow(newSettings);
      if(!ok) return;
    }
    settings = newSettings;
    document.getElementById('siteTitle').textContent = 'Wally Wiki';
    const sidebarSubtitle = document.getElementById('sidebarSubtitle');
    if(sidebarSubtitle){
      sidebarSubtitle.textContent = settings.subtitle || DEFAULT_SETTINGS.subtitle;
    }
    document.title = 'Wally Wiki';
    closeModal();
    showToast('Settings saved');
  };
}

function openCategoriesModal(){
  renderCategoriesModal();
}

function openTagsModal(){
  renderTagsModal();
}

function renderTagsModal(){
  const tags = allTags();
  const rows = tags.map(([t,count])=>`
    <div class="tag-item" style="cursor:default;gap:8px;">
      <input type="text" class="rename-tag-input mono" data-old-tag="${escapeAttr(t)}" value="${escapeAttr(t)}" style="flex:1;border:1px solid transparent;background:transparent;font:inherit;color:inherit;padding:2px 4px;">
      <span class="count">${count}</span>
    </div>`).join('') || `<div style="font-size:13px;color:var(--ink-faint);padding:6px 0;">No tags yet — they're added per-resource in the resource form.</div>`;

  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <button class="modal-close-x" id="closeX">&times;</button>
        <h3>Manage tags</h3>
        <p class="sub">Click a tag to rename it everywhere it's used. Tags themselves are added/removed per-resource in the resource form — there's no separate add/remove list here.</p>

        <div class="tag-list modal-tag-list" id="tagManageList">${rows}</div>

        <div class="modal-actions">
          <button class="btn" id="closeTagsModal">Done</button>
        </div>
      </div>
    </div>`;

  const overlay = document.getElementById('overlay');
  overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
  document.getElementById('closeX').onclick = closeModal;
  document.getElementById('closeTagsModal').onclick = closeModal;

  document.querySelectorAll('.rename-tag-input').forEach(inp=>{
    const commit = async ()=>{
      const oldName = inp.dataset.oldTag;
      if(inp.value.trim() === oldName || !inp.value.trim()) { inp.value = oldName; return; }
      const ok = await renameTag(oldName, inp.value);
      if(ok){ renderTagsModal(); renderAll(); showToast('Tag renamed'); }
      else { inp.value = oldName; }
    };
    inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); inp.blur(); } });
    inp.addEventListener('blur', commit);
  });
}

function renderCategoriesModal(){
  const rows = categories.map(c=>{
    const count = resources.filter(r=>r.category===c).length;
    return `<div class="tag-item draggable-row" draggable="true" data-cat="${escapeAttr(c)}" style="cursor:default;gap:8px;">
      <span class="drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span>
      <input type="text" class="rename-cat-input mono" data-old-cat="${escapeAttr(c)}" value="${escapeAttr(c)}" style="flex:1;border:1px solid transparent;background:transparent;font:inherit;color:inherit;padding:2px 4px;">
      <span class="count">${count}</span>
      <button class="icon-btn del" data-remove-cat="${escapeAttr(c)}">Remove</button>
    </div>`;
  }).join('') || `<div style="font-size:13px;color:var(--ink-faint);padding:6px 0;">No categories yet — add one below.</div>`;

  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <button class="modal-close-x" id="closeX">&times;</button>
        <h3>Manage categories</h3>
        <p class="sub">Drag a row by its ⠿ handle to reorder — that order is used everywhere: the sidebar list and the section order in the main feed. Click a name to rename it (updates every resource in it), add categories ahead of time, or remove ones you no longer need. Removing a category moves any resources in it to "Uncategorized" — it doesn't delete them.</p>

        <div class="tag-list modal-tag-list" id="categoryManageList" style="margin-bottom:16px;">${rows}</div>

        <div class="field">
          <label for="newCatInput">Add a category</label>
          <div style="display:flex;gap:8px;">
            <input type="text" id="newCatInput" placeholder="e.g. Research" style="flex:1;">
            <button class="btn btn-primary btn-sm" id="addCatBtn">Add</button>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn" id="closeCategoriesModal">Done</button>
        </div>
      </div>
    </div>`;

  const overlay = document.getElementById('overlay');
  overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
  document.getElementById('closeX').onclick = closeModal;
  document.getElementById('closeCategoriesModal').onclick = closeModal;

  const newCatInput = document.getElementById('newCatInput');
  const addCat = async ()=>{
    const ok = await addCategory(newCatInput.value);
    if(ok){ renderCategoriesModal(); renderAll(); showToast('Category added'); }
  };
  document.getElementById('addCatBtn').onclick = addCat;
  newCatInput.addEventListener('keydown', e=>{ if(e.key==='Enter') addCat(); });

  document.querySelectorAll('.rename-cat-input').forEach(inp=>{
    const commit = async ()=>{
      const oldName = inp.dataset.oldCat;
      if(inp.value.trim() === oldName) return;
      const ok = await renameCategory(oldName, inp.value);
      if(ok){ renderCategoriesModal(); renderAll(); showToast('Category renamed'); }
      else { inp.value = oldName; }
    };
    inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); inp.blur(); } });
    inp.addEventListener('blur', commit);
  });

  document.querySelectorAll('[data-remove-cat]').forEach(btn=>{
    btn.onclick = async ()=>{
      if(btn.dataset.confirming === '1'){
        const name = btn.dataset.removeCat;
        const ok = await removeCategory(name);
        if(ok){
          renderCategoriesModal();
          renderAll();
          showToast(`Removed "${name}"`);
        }
        return;
      }
      btn.dataset.confirming = '1';
      const original = btn.textContent;
      btn.textContent = 'Confirm?';
      setTimeout(()=>{
        if(btn.dataset.confirming === '1'){
          btn.dataset.confirming = '0';
          btn.textContent = original;
        }
      }, 2500);
    };
  });

  // ---- Drag to reorder — this order is used everywhere (sidebar + feed) ----
  const catListEl = document.getElementById('categoryManageList');
  let draggedCat = null;
  catListEl.querySelectorAll('.draggable-row').forEach(row=>{
    row.addEventListener('dragstart', e=>{
      draggedCat = row.dataset.cat;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedCat);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', ()=>{
      row.classList.remove('dragging');
      catListEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', e=>{
      e.preventDefault();
      if(row.dataset.cat === draggedCat) return;
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', ()=>{ row.classList.remove('drag-over'); });
    row.addEventListener('drop', async e=>{
      e.preventDefault();
      row.classList.remove('drag-over');
      const draggedName = e.dataTransfer.getData('text/plain');
      const targetName = row.dataset.cat;
      if(!draggedName || draggedName === targetName) return;
      const from = categories.indexOf(draggedName);
      const to = categories.indexOf(targetName);
      if(from === -1 || to === -1) return;
      const updated = [...categories];
      updated.splice(from, 1);
      updated.splice(to, 0, draggedName);
      const ok = await reorderCategories(updated);
      if(ok){ renderCategoriesModal(); renderAll(); }
    });
  });
}

/* ---------------- Import tidbits from an AI chatbot ---------------- */
function buildTidbitPrompt(resource){
  const contentBlock = resource.sourceText && resource.sourceText.trim()
    ? resource.sourceText.trim()
    : '[Paste the page content here — select-all/copy the page and paste it in place of this line]';
  return `I'm building entries for a resource directory. Here's a resource: "${resource.title}"${resource.url ? ` (${resource.url})` : ''}.

Read the content below and pull out useful individual facts, tips, or ideas as short, standalone bullet points — specific things someone browsing a directory would want to know (e.g. "walk-in hours: Tue/Thu 2-4pm", "no ID needed for entry", "has a laser cutter available"). Skip generic marketing fluff.

Group related bullets under short topic headers (like "Hours", "Access", "Equipment", "Cost").

Format your answer EXACTLY like this, with no extra commentary before or after:

## Topic Name
- tidbit one
- tidbit two

## Another Topic
- tidbit three

Content:
"""
${contentBlock}
"""`;
}

// Combined prompt for the "Add resource" screen's single AI round-trip:
// one prompt covers both the directory-entry fields AND field notes, so
// pasting one reply back fills in everything at once (used when the
// automatic URL-fetch autofill can't reach a page, or when the admin would
// rather run it through their own chatbot).
function buildCombinedPrompt(draft, categoryList, topicList){
  const contentBlock = draft.sourceText && draft.sourceText.trim()
    ? draft.sourceText.trim()
    : '[Paste the page content here — select-all/copy the page and paste it in place of this line]';
  return `I'm cataloging a resource for a shared community resource directory.${draft.title ? ` Working title: "${draft.title}".` : ''}${draft.url ? ` URL: ${draft.url}.` : ''}
Existing categories already in use: ${categoryList.length ? categoryList.join(', ') : '(none yet)'}
Existing field-note topics already in use: ${topicList.length ? topicList.join(', ') : '(none yet)'}

Read the content below and give me back TWO things.

1. Directory entry fields:
TITLE: a short, human-friendly title
DESCRIPTION: 1-2 plain sentences on what this is, mentioning anything a visitor should know before clicking (sign-in required, cost, hours, etc.)
CATEGORY: the single best-fit category — reuse an existing one if it fits, else propose a short new one
TAGS: 3-5 short, specific tag phrases, comma separated

2. Field notes: individual facts, tips, or ideas as short standalone bullet points — specific things someone browsing a directory would want to know (e.g. "walk-in hours: Tue/Thu 2-4pm", "no ID needed for entry"). Skip generic marketing fluff. Group related bullets under short topic headers, reusing an existing topic name if one fits.

Format your answer EXACTLY like this, with no extra commentary before or after:

TITLE: ...
DESCRIPTION: ...
CATEGORY: ...
TAGS: tag one, tag two, tag three

## Topic Name
- tidbit one
- tidbit two

## Another Topic
- tidbit three

Content:
"""
${contentBlock}
"""`;
}

function openImportTidbitsModal(){
  const options = resources.slice().sort((a,b)=>a.title.localeCompare(b.title))
    .map(r=>`<option value="${r.id}">${escapeHtml(r.title)}</option>`).join('');

  if(!resources.length){
    document.getElementById('modalRoot').innerHTML = `
      <div class="overlay" id="overlay">
        <div class="modal">
          <button class="modal-close-x" id="closeX">&times;</button>
          <h3>Import tips</h3>
          <p class="sub">Add at least one resource first — every tip needs a source to link back to.</p>
          <div class="modal-actions"><button class="btn" id="closeNoRes">Close</button></div>
        </div>
      </div>`;
    document.getElementById('overlay').onclick = (e)=>{ if(e.target===document.getElementById('overlay')) closeModal(); };
    document.getElementById('closeX').onclick = closeModal;
    document.getElementById('closeNoRes').onclick = closeModal;
    return;
  }

  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" style="max-width:600px;">
        <button class="modal-close-x" id="closeX">&times;</button>
        <h3>Import tips</h3>
        <p class="sub">Pick a resource, copy a ready-made prompt into any AI chatbot, then paste its reply back here. Nothing saves until you review it below.</p>

        <div class="field">
          <label for="tidbitResourceSelect">Resource</label>
          <select id="tidbitResourceSelect">${options}</select>
        </div>

        <div class="field">
          <button class="btn btn-sm" id="copyPromptBtn" type="button">Copy prompt for AI</button>
          <span id="copyPromptStatus" style="font-size:12.5px;color:var(--ink-faint);margin-left:8px;"></span>
        </div>

        <div class="field">
          <label for="tidbitPasteArea">Paste the chatbot's reply here</label>
          <textarea id="tidbitPasteArea" style="min-height:120px;" placeholder="Paste the AI's response..."></textarea>
        </div>

        <div class="modal-actions" style="justify-content:flex-start;margin-top:0;margin-bottom:16px;">
          <button class="btn btn-primary btn-sm" id="processTidbitsBtn" type="button">Process</button>
          <span id="tidbitParseStatus" style="font-size:12.5px;color:var(--ink-faint);"></span>
        </div>

        <div id="tidbitReviewArea"></div>

        <div class="modal-actions">
          <button class="btn" id="cancelTidbitImport">Close</button>
        </div>
      </div>
    </div>`;

  const overlay = document.getElementById('overlay');
  overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
  document.getElementById('closeX').onclick = closeModal;
  document.getElementById('cancelTidbitImport').onclick = closeModal;

  const resourceSelect = document.getElementById('tidbitResourceSelect');
  const copyStatus = document.getElementById('copyPromptStatus');
  document.getElementById('copyPromptBtn').onclick = async ()=>{
    const res = resources.find(r=>r.id===resourceSelect.value);
    if(!res) return;
    const prompt = buildTidbitPrompt(res);
    try{
      await navigator.clipboard.writeText(prompt);
      copyStatus.textContent = '✓ Copied — paste it into your chatbot of choice';
    } catch(e){
      copyStatus.textContent = "Couldn't copy automatically — it's in the paste box below, select and copy manually.";
      document.getElementById('tidbitPasteArea').value = prompt;
    }
  };

  let reviewData = null; // { resourceId, topics: [{ topic, tidbits: [string] }] }

  document.getElementById('processTidbitsBtn').onclick = async ()=>{
    const text = document.getElementById('tidbitPasteArea').value.trim();
    const statusEl = document.getElementById('tidbitParseStatus');
    if(!text){ statusEl.textContent = 'Paste the chatbot reply first.'; return; }
    if(!AUTOFILL_URL || !CONFIGURED){ statusEl.textContent = 'AI parsing needs Supabase configured.'; return; }
    statusEl.textContent = '✨ Parsing…';
    try{
      const { data: sessionData } = await supabaseClient.auth.getSession();
      const token = sessionData && sessionData.session ? sessionData.session.access_token : null;
      if(!token){ statusEl.textContent = 'You must be logged in.'; return; }

      let res;
      try{
        res = await fetch(AUTOFILL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ action: 'parse_tidbits', pastedText: text, topics: tidbitTopics })
        });
      } catch(e){
        statusEl.textContent = "Couldn't reach the parsing function — check it's deployed.";
        return;
      }
      let result;
      try{ result = await res.json(); } catch(e){
        statusEl.textContent = `Unexpected response (status ${res.status}) — check the function is up to date.`;
        return;
      }
      if(!res.ok || result.error){
        statusEl.textContent = result.error ? `Couldn't parse: ${result.error}` : "Couldn't parse.";
        return;
      }
      reviewData = { resourceId: resourceSelect.value, topics: Array.isArray(result.topics) ? result.topics : [] };
      statusEl.textContent = reviewData.topics.length ? '✓ Parsed — review below before saving' : 'No tidbits found in that text.';
      renderTidbitReview();
    } catch(e){
      statusEl.textContent = "Something went wrong parsing that.";
    }
  };

  function renderTidbitReview(){
    const area = document.getElementById('tidbitReviewArea');
    if(!reviewData || !reviewData.topics.length){
      area.innerHTML = '';
      return;
    }
    area.innerHTML = `<div style="border-top:1px solid var(--line);padding-top:14px;margin-bottom:6px;">
      ${reviewData.topics.map((tg, ti)=>`
        <div class="field" data-review-topic="${ti}">
          <input type="text" class="review-topic-name" data-ti="${ti}" value="${escapeAttr(tg.topic)}" style="font-weight:600;margin-bottom:8px;">
          ${tg.tidbits.map((tb, bi)=>`
            <div style="display:flex;gap:6px;margin-bottom:6px;align-items:flex-start;">
              <textarea class="review-tidbit-text" data-ti="${ti}" data-bi="${bi}" style="flex:1;min-height:44px;font-size:13.5px;">${escapeHtml(tb)}</textarea>
              <button class="icon-btn del" data-remove-tidbit data-ti="${ti}" data-bi="${bi}" title="Remove">×</button>
            </div>
          `).join('')}
          <button class="btn-ghost btn-sm" data-add-tidbit data-ti="${ti}" style="padding:2px 0;">+ Add bullet to this card</button>
        </div>
      `).join('')}
      <button class="btn btn-sm" id="saveTidbitsBtn" type="button" style="margin-top:8px;">Add these tips</button>
    </div>`;

    area.querySelectorAll('.review-topic-name').forEach(inp=>{
      inp.addEventListener('input', ()=>{ reviewData.topics[Number(inp.dataset.ti)].topic = inp.value; });
    });
    area.querySelectorAll('.review-tidbit-text').forEach(ta=>{
      ta.addEventListener('input', ()=>{ reviewData.topics[Number(ta.dataset.ti)].tidbits[Number(ta.dataset.bi)] = ta.value; });
    });
    area.querySelectorAll('[data-remove-tidbit]').forEach(btn=>{
      btn.onclick = ()=>{
        reviewData.topics[Number(btn.dataset.ti)].tidbits.splice(Number(btn.dataset.bi), 1);
        renderTidbitReview();
      };
    });
    area.querySelectorAll('[data-add-tidbit]').forEach(btn=>{
      btn.onclick = ()=>{
        reviewData.topics[Number(btn.dataset.ti)].tidbits.push('');
        renderTidbitReview();
      };
    });

    document.getElementById('saveTidbitsBtn').onclick = async ()=>{
      let count = 0;
      for(const tg of reviewData.topics){
        let topicName = (tg.topic || 'General').trim() || 'General';
        if(topicName.toLowerCase() !== 'general'){
          const match = tidbitTopics.find(t=>t.toLowerCase()===topicName.toLowerCase());
          if(match){ topicName = match; }
          else { await addTidbitTopic(topicName); }
        }
        let pos = tidbits.filter(t=>t.topic===topicName).length;
        for(const text of tg.tidbits){
          const clean = (text||'').trim();
          if(!clean) continue;
          const saved = await insertTidbit({ resourceId: reviewData.resourceId, topic: topicName, text: clean, position: pos++ });
          if(saved){ tidbits.push(saved); count++; }
        }
      }
      closeModal();
      renderAll();
      showToast(`Added ${count} tip${count===1?'':'s'}`);
    };
  }
}

function openTidbitTopicsModal(){
  renderTidbitTopicsModal();
}

function renderTidbitTopicsModal(){
  const groupRows = tidbitGroups.map(g=>{
    const count = tidbits.filter(x=> groupForTopic(x.topic || 'General') === g).length;
    return `<div class="tag-item draggable-row" draggable="true" data-group="${escapeAttr(g)}" style="cursor:default;gap:8px;">
      <span class="drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span>
      <input type="text" class="rename-group-input mono" data-old-group="${escapeAttr(g)}" value="${escapeAttr(g)}" style="flex:1;border:1px solid transparent;background:transparent;font:inherit;color:inherit;padding:2px 4px;">
      <span class="count">${count}</span>
      <button class="icon-btn del" data-remove-group="${escapeAttr(g)}">Remove</button>
    </div>`;
  }).join('') || `<div style="font-size:13px;color:var(--ink-faint);padding:6px 0;">No groups yet — add one below.</div>`;

  const groupOptions = ['<option value="">Ungrouped</option>', ...tidbitGroups.map(g=>`<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`)].join('');
  const topicRows = tidbitTopics.map(t=>{
    const count = tidbits.filter(x=>x.topic===t).length;
    const currentGroup = topicGroups[t] || '';
    return `<div class="tag-item" style="cursor:default;gap:8px;">
      <input type="text" class="rename-topic-input mono" data-old-topic="${escapeAttr(t)}" value="${escapeAttr(t)}" style="flex:1;border:1px solid transparent;background:transparent;font:inherit;color:inherit;padding:2px 4px;">
      <select class="topic-group-select" data-topic="${escapeAttr(t)}" style="font-size:12.5px;">
        ${groupOptions.replace(`value="${escapeAttr(currentGroup)}"`, `value="${escapeAttr(currentGroup)}" selected`)}
      </select>
      <span class="count">${count}</span>
      <button class="icon-btn del" data-remove-topic="${escapeAttr(t)}">Remove</button>
    </div>`;
  }).join('') || `<div style="font-size:13px;color:var(--ink-faint);padding:6px 0;">No topics yet — add one below, or just import some tips.</div>`;

  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <button class="modal-close-x" id="closeX">&times;</button>
        <h3>Manage topics &amp; groups</h3>
        <p class="sub">Groups are the top-level sections in Tips (e.g. Clubs, Academics, Dining). Drag a group by its ⠿ handle to reorder — that order is used everywhere: the sidebar list and the section order in Tips. Every topic can sit in one group. Click any name to rename it.</p>

        <h4 style="margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint);">Groups</h4>
        <div class="tag-list modal-tag-list" id="groupManageList" style="margin-bottom:12px;">${groupRows}</div>
        <div class="field">
          <div style="display:flex;gap:8px;">
            <input type="text" id="newGroupInput" placeholder="e.g. Clubs" style="flex:1;">
            <button class="btn btn-primary btn-sm" id="addGroupBtn">Add group</button>
          </div>
        </div>

        <h4 style="margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint);">Topics</h4>
        <div class="tag-list modal-tag-list" id="topicManageList" style="margin-bottom:16px;">${topicRows}</div>
        <div class="field">
          <label for="newTopicInput">Add a topic</label>
          <div style="display:flex;gap:8px;">
            <input type="text" id="newTopicInput" placeholder="e.g. Hours" style="flex:1;">
            <button class="btn btn-primary btn-sm" id="addTopicBtn">Add</button>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn" id="closeTopicsModal">Done</button>
        </div>
      </div>
    </div>`;

  const overlay = document.getElementById('overlay');
  overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
  document.getElementById('closeX').onclick = closeModal;
  document.getElementById('closeTopicsModal').onclick = closeModal;

  const newGroupInput = document.getElementById('newGroupInput');
  const addGroup = async ()=>{
    const ok = await addTidbitGroup(newGroupInput.value);
    if(ok){ renderTidbitTopicsModal(); renderSidebarTidbits(); showToast('Group added'); }
  };
  document.getElementById('addGroupBtn').onclick = addGroup;
  newGroupInput.addEventListener('keydown', e=>{ if(e.key==='Enter') addGroup(); });

  document.querySelectorAll('.rename-group-input').forEach(inp=>{
    const commit = async ()=>{
      const oldName = inp.dataset.oldGroup;
      if(inp.value.trim() === oldName) return;
      const ok = await renameTidbitGroup(oldName, inp.value);
      if(ok){ renderTidbitTopicsModal(); renderFieldNotes(); renderSidebarTidbits(); showToast('Group renamed'); }
      else { inp.value = oldName; }
    };
    inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); inp.blur(); } });
    inp.addEventListener('blur', commit);
  });

  document.querySelectorAll('[data-remove-group]').forEach(btn=>{
    btn.onclick = async ()=>{
      if(btn.dataset.confirming === '1'){
        const name = btn.dataset.removeGroup;
        const ok = await removeTidbitGroup(name);
        if(ok){ renderTidbitTopicsModal(); renderFieldNotes(); renderSidebarTidbits(); showToast(`Removed "${name}"`); }
        return;
      }
      btn.dataset.confirming = '1';
      const original = btn.textContent;
      btn.textContent = 'Confirm?';
      setTimeout(()=>{
        if(btn.dataset.confirming === '1'){ btn.dataset.confirming = '0'; btn.textContent = original; }
      }, 2500);
    };
  });

  const newTopicInput = document.getElementById('newTopicInput');
  const addTopic = async ()=>{
    const ok = await addTidbitTopic(newTopicInput.value);
    if(ok){ renderTidbitTopicsModal(); showToast('Topic added'); }
  };
  document.getElementById('addTopicBtn').onclick = addTopic;
  newTopicInput.addEventListener('keydown', e=>{ if(e.key==='Enter') addTopic(); });

  document.querySelectorAll('.rename-topic-input').forEach(inp=>{
    const commit = async ()=>{
      const oldName = inp.dataset.oldTopic;
      if(inp.value.trim() === oldName) return;
      const ok = await renameTidbitTopic(oldName, inp.value);
      if(ok){ renderTidbitTopicsModal(); renderFieldNotes(); renderSidebarTidbits(); showToast('Topic renamed'); }
      else { inp.value = oldName; }
    };
    inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); inp.blur(); } });
    inp.addEventListener('blur', commit);
  });

  document.querySelectorAll('.topic-group-select').forEach(sel=>{
    sel.onchange = async ()=>{
      const ok = await setTopicGroup(sel.dataset.topic, sel.value);
      if(ok){ renderFieldNotes(); renderSidebarTidbits(); showToast('Group updated'); }
    };
  });

  document.querySelectorAll('[data-remove-topic]').forEach(btn=>{
    btn.onclick = async ()=>{
      if(btn.dataset.confirming === '1'){
        const name = btn.dataset.removeTopic;
        const ok = await removeTidbitTopic(name);
        if(ok){
          renderTidbitTopicsModal();
          renderFieldNotes();
          renderSidebarTidbits();
          showToast(`Removed "${name}"`);
        }
        return;
      }
      btn.dataset.confirming = '1';
      const original = btn.textContent;
      btn.textContent = 'Confirm?';
      setTimeout(()=>{
        if(btn.dataset.confirming === '1'){
          btn.dataset.confirming = '0';
          btn.textContent = original;
        }
      }, 2500);
    };
  });

  // ---- Drag to reorder groups — this order is used everywhere (sidebar + Tips) ----
  const groupListEl = document.getElementById('groupManageList');
  let draggedGroup = null;
  groupListEl.querySelectorAll('.draggable-row').forEach(row=>{
    row.addEventListener('dragstart', e=>{
      draggedGroup = row.dataset.group;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedGroup);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', ()=>{
      row.classList.remove('dragging');
      groupListEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', e=>{
      e.preventDefault();
      if(row.dataset.group === draggedGroup) return;
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', ()=>{ row.classList.remove('drag-over'); });
    row.addEventListener('drop', async e=>{
      e.preventDefault();
      row.classList.remove('drag-over');
      const draggedName = e.dataTransfer.getData('text/plain');
      const targetName = row.dataset.group;
      if(!draggedName || draggedName === targetName) return;
      const from = tidbitGroups.indexOf(draggedName);
      const to = tidbitGroups.indexOf(targetName);
      if(from === -1 || to === -1) return;
      const updated = [...tidbitGroups];
      updated.splice(from, 1);
      updated.splice(to, 0, draggedName);
      const ok = await reorderTidbitGroups(updated);
      if(ok){ renderTidbitTopicsModal(); renderFieldNotes(); renderSidebarTidbits(); }
    });
  });
}

/* ---------------- Utils ---------------- */
function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s){ return escapeHtml(s); }

let toastTimer;
let searchRenderTimer;
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove('show'), 2200);
}

/* ---------------- Search binding ---------------- */
document.getElementById('searchInput').addEventListener('input', (e)=>{
  searchQuery = e.target.value;
  clearTimeout(searchRenderTimer);
  searchRenderTimer = setTimeout(()=>{
    renderMain();
    document.getElementById('clearFilters').style.display = (activeTag || activeType || searchQuery) ? 'block' : 'none';
    updateSidebarToggleLabel();
  }, 100);
});
document.getElementById('clearFilters').addEventListener('click', ()=>{
  activeTag = null; activeType = null; searchQuery = '';
  document.getElementById('searchInput').value = '';
  renderAll();
});

/* ---------------- Mobile sidebar toggle ----------------
   On phones/tablets the filter sections (categories, type, tags, groups,
   topics) start collapsed behind this button so the title and cards are
   visible right away; on desktop this button is hidden by CSS and the
   sidebar is always open. */
document.getElementById('sidebarToggle').addEventListener('click', ()=>{
  const toggle = document.getElementById('sidebarToggle');
  const body = document.getElementById('sidebarBody');
  const nowOpen = !body.classList.contains('open');
  body.classList.toggle('open', nowOpen);
  toggle.setAttribute('aria-expanded', String(nowOpen));
  updateSidebarToggleLabel();
});

function updateSidebarToggleLabel(){
  const toggle = document.getElementById('sidebarToggle');
  const label = document.getElementById('sidebarToggleLabel');
  const isOpen = toggle.getAttribute('aria-expanded') === 'true';
  const activeCount = (activeTag ? 1 : 0) + (activeType ? 1 : 0) + (searchQuery ? 1 : 0);
  const base = isOpen ? 'Hide filters' : 'Show filters';
  label.textContent = activeCount > 0 ? `${base} (${activeCount} active)` : base;
}

init();