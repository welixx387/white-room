'use strict';

/* =========================================================================
   White Room — личная библиотека контента.
   Всё хранится локально: тексты в localStorage, изображения — в IndexedDB.
   Никаких серверов, логинов и внешних API.
   ========================================================================= */

/* ------------------------------- Утилиты ------------------------------- */

// Генератор простых уникальных id (без внешних зависимостей)
function makeId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

// Экранирование текста при вставке в innerHTML
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// Старый обычный текст описания -> HTML-абзацы (для миграции старых записей)
function textToContentHtml(text) {
  if (!text) return '';
  return '<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>';
}

/* ============================ IndexedDB слой ============================
   Храним изображения (обложки и картинки внутри текста) как Blob в IndexedDB —
   localStorage слишком мал для картинок. В основном JSON (localStorage)
   храним только ссылки на них (coverId / data-cover-id).
   ========================================================================= */

const IDB_NAME = 'whiteRoomDB';
const IDB_VERSION = 1;
const IDB_STORE = 'covers';

let idbInstance = null;

function openImageDB() {
  if (idbInstance) return Promise.resolve(idbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => { idbInstance = req.result; resolve(idbInstance); };
    req.onerror = () => reject(req.error);
  });
}

async function idbPutImage(id, blob) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDeleteImage(id) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAllImages() {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const result = new Map();
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        result.set(cursor.key, cursor.value);
        cursor.continue();
      } else {
        resolve(result);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

// Сжимаем изображение до заданной ширины через canvas и возвращаем Blob (JPEG)
function resizeImageToBlob(file, maxWidth = 800, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Не удалось обработать изображение'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось загрузить изображение')); };
    img.src = url;
  });
}

/* ===== Кэш object URL для показа изображений из IndexedDB на странице ===== */
const imageUrlCache = new Map(); // id -> object URL

function getCachedImageUrl(id) {
  return id ? imageUrlCache.get(id) || null : null;
}

async function preloadAllImages() {
  const all = await idbGetAllImages();
  for (const [id, blob] of all.entries()) {
    imageUrlCache.set(id, URL.createObjectURL(blob));
  }
}

async function setImageForCover(id, blob) {
  await idbPutImage(id, blob);
  const old = imageUrlCache.get(id);
  if (old) URL.revokeObjectURL(old);
  imageUrlCache.set(id, URL.createObjectURL(blob));
}

async function removeCoverImage(id) {
  if (!id) return;
  await idbDeleteImage(id);
  const old = imageUrlCache.get(id);
  if (old) URL.revokeObjectURL(old);
  imageUrlCache.delete(id);
}

/* ============================ Цветовые метки ============================= */

const COLOR_PALETTE = [
  { name: 'Стальной',  value: '#7C93A6' },
  { name: 'Графит',    value: '#5C6672' },
  { name: 'Иней',      value: '#A9C2CE' },
  { name: 'Пепел',     value: '#8A8A85' },
  { name: 'Кость',     value: '#C9C2B4' },
  { name: 'Ржавчина',  value: '#B4715A' },
  { name: 'Мох',       value: '#7C8C6E' },
  { name: 'Вино',      value: '#8C5A63' },
];

function renderColorSwatches(container, selectedColor, onSelect) {
  container.innerHTML = '';
  const makeBtn = (value, label) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch' + (value ? '' : ' swatch--none');
    if (value) btn.style.setProperty('--swatch-color', value);
    const selected = (selectedColor || null) === value;
    if (selected) btn.classList.add('is-selected');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(selected));
    btn.addEventListener('click', () => {
      container.querySelectorAll('.swatch').forEach((b) => {
        b.classList.remove('is-selected');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('is-selected');
      btn.setAttribute('aria-pressed', 'true');
      onSelect(value);
    });
    return btn;
  };
  container.appendChild(makeBtn(null, 'Без цвета'));
  COLOR_PALETTE.forEach((c) => container.appendChild(makeBtn(c.value, c.name)));
}

/* ================================ Store =================================
   Категории и программы. Автосохранение в localStorage при каждом действии.
   ========================================================================= */

const STORAGE_KEY = 'whiteRoom:data';

const store = {
  categories: [],

  load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    try {
      this.categories = raw ? JSON.parse(raw) : [];
    } catch {
      this.categories = [];
    }
    this._migrate();
  },

  // Приводим старые записи (без color/contentHtml) к текущему формату
  _migrate() {
    let changed = false;
    this.categories.forEach((cat) => {
      if (!('color' in cat)) { cat.color = null; changed = true; }
      (cat.programs || []).forEach((prog) => {
        if (!('contentHtml' in prog)) {
          prog.contentHtml = textToContentHtml(prog.description || '');
          delete prog.description;
          changed = true;
        }
        if (!('color' in prog)) { prog.color = null; changed = true; }
      });
    });
    if (changed) this.save();
  },

  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.categories));
    notifySaved();
  },

  getCategory(id) {
    return this.categories.find((c) => c.id === id) || null;
  },

  addCategory(name, color) {
    const cat = { id: makeId('cat'), name, color: color || null, order: this.categories.length, programs: [] };
    this.categories.push(cat);
    this.save();
    return cat;
  },

  updateCategory(id, name, color) {
    const cat = this.getCategory(id);
    if (!cat) return;
    cat.name = name;
    cat.color = color || null;
    this.save();
  },

  deleteCategory(id) {
    const cat = this.getCategory(id);
    if (!cat) return;
    cat.programs.forEach((p) => removeAllProgramImages(p));
    this.categories = this.categories.filter((c) => c.id !== id);
    this.categories.forEach((c, i) => { c.order = i; });
    this.save();
  },

  reorderCategories(fromId, toId) {
    const fromIdx = this.categories.findIndex((c) => c.id === fromId);
    const toIdx = this.categories.findIndex((c) => c.id === toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const [moved] = this.categories.splice(fromIdx, 1);
    this.categories.splice(toIdx, 0, moved);
    this.categories.forEach((c, i) => { c.order = i; });
    this.save();
  },

  addProgram(categoryId, { title, color, coverId, contentHtml }) {
    const cat = this.getCategory(categoryId);
    if (!cat) return null;
    const prog = { id: makeId('prog'), title, color: color || null, coverId: coverId || null, contentHtml: contentHtml || '' };
    cat.programs.push(prog);
    this.save();
    return prog;
  },

  updateProgram(categoryId, programId, patch) {
    const cat = this.getCategory(categoryId);
    if (!cat) return;
    const prog = cat.programs.find((p) => p.id === programId);
    if (!prog) return;
    Object.assign(prog, patch);
    this.save();
  },

  // Переносит программу в другую категорию (при смене категории в форме редактирования)
  moveProgram(fromCategoryId, toCategoryId, programId, patch) {
    const fromCat = this.getCategory(fromCategoryId);
    const toCat = this.getCategory(toCategoryId);
    if (!fromCat || !toCat) return;
    const idx = fromCat.programs.findIndex((p) => p.id === programId);
    if (idx === -1) return;
    const [prog] = fromCat.programs.splice(idx, 1);
    Object.assign(prog, patch);
    toCat.programs.push(prog);
    this.save();
  },

  deleteProgram(categoryId, programId) {
    const cat = this.getCategory(categoryId);
    if (!cat) return;
    const prog = cat.programs.find((p) => p.id === programId);
    if (prog) removeAllProgramImages(prog);
    cat.programs = cat.programs.filter((p) => p.id !== programId);
    this.save();
  },

  reorderPrograms(categoryId, fromId, toId) {
    const cat = this.getCategory(categoryId);
    if (!cat) return;
    const fromIdx = cat.programs.findIndex((p) => p.id === fromId);
    const toIdx = cat.programs.findIndex((p) => p.id === toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const [moved] = cat.programs.splice(fromIdx, 1);
    cat.programs.splice(toIdx, 0, moved);
    this.save();
  },
};

function extractImageIds(html) {
  if (!html) return [];
  const container = document.createElement('div');
  container.innerHTML = html;
  return Array.from(container.querySelectorAll('img[data-cover-id]')).map((img) => img.getAttribute('data-cover-id'));
}

function removeAllProgramImages(prog) {
  if (prog.coverId) removeCoverImage(prog.coverId);
  extractImageIds(prog.contentHtml).forEach((id) => removeCoverImage(id));
}

/* ============================ Индикатор сохранения ======================= */

const saveToastEl = document.getElementById('saveToast');
let toastTimer = null;
function notifySaved() {
  saveToastEl.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => saveToastEl.classList.remove('visible'), 1400);
}

/* ================================ Состояние UI ============================ */

const ui = {
  view: 'categories', // 'categories' | 'programs'
  currentCategoryId: null,
  searchTerm: '',
  editingCategoryId: null,
  editingProgramId: null,
  pendingCoverBlob: null,
  pendingCoverId: null,
  removeCoverFlag: false,
  draggedId: null,
  selectedCategoryColor: null,
  selectedProgramColor: null,
};

/* ================================ DOM ссылки =============================== */

const el = {
  introScreen: document.getElementById('introScreen'),
  introKicker: document.getElementById('introKicker'),
  introQuote: document.getElementById('introQuote'),
  introEnterBtn: document.getElementById('introEnterBtn'),

  categoriesView: document.getElementById('categoriesView'),
  programsView: document.getElementById('programsView'),
  categoriesGrid: document.getElementById('categoriesGrid'),
  programsGrid: document.getElementById('programsGrid'),
  categoriesEmpty: document.getElementById('categoriesEmpty'),
  programsEmpty: document.getElementById('programsEmpty'),
  subbar: document.getElementById('subbar'),
  categoryTitle: document.getElementById('categoryTitle'),
  backBtn: document.getElementById('backBtn'),
  brandBtn: document.getElementById('brandBtn'),
  searchInput: document.getElementById('searchInput'),
  fabBtn: document.getElementById('fabBtn'),

  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile'),

  categoryModalBackdrop: document.getElementById('categoryModalBackdrop'),
  categoryModal: document.getElementById('categoryModal'),
  categoryForm: document.getElementById('categoryForm'),
  categoryModalTitle: document.getElementById('categoryModalTitle'),
  categoryNameInput: document.getElementById('categoryNameInput'),
  categoryColorSwatches: document.getElementById('categoryColorSwatches'),

  programModalBackdrop: document.getElementById('programModalBackdrop'),
  programModal: document.getElementById('programModal'),
  programForm: document.getElementById('programForm'),
  programModalTitle: document.getElementById('programModalTitle'),
  programTitleInput: document.getElementById('programTitleInput'),
  programCategorySelect: document.getElementById('programCategorySelect'),
  programColorSwatches: document.getElementById('programColorSwatches'),
  dropzone: document.getElementById('dropzone'),
  dropzoneHint: document.getElementById('dropzoneHint'),
  coverPreview: document.getElementById('coverPreview'),
  coverFileInput: document.getElementById('coverFileInput'),
  removeCoverBtn: document.getElementById('removeCoverBtn'),
  programEditor: document.getElementById('programEditor'),
  editorImageInput: document.getElementById('editorImageInput'),

  viewModalBackdrop: document.getElementById('viewModalBackdrop'),
  viewModal: document.getElementById('viewModal'),
  viewModalTitle: document.getElementById('viewModalTitle'),
  viewModalText: document.getElementById('viewModalText'),
  viewCoverImg: document.getElementById('viewCoverImg'),

  confirmModalBackdrop: document.getElementById('confirmModalBackdrop'),
  confirmModal: document.getElementById('confirmModal'),
  confirmModalTitle: document.getElementById('confirmModalTitle'),
  confirmModalText: document.getElementById('confirmModalText'),
  confirmDeleteBtn: document.getElementById('confirmDeleteBtn'),
};

/* ============================ Модалки + фокус-ловушка ====================== */

let lastFocusedEl = null;
let activeModalBackdrop = null;

function getFocusable(container) {
  return Array.from(
    container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((elm) => !elm.disabled && elm.offsetParent !== null);
}

function trapFocusHandler(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeActiveModal();
    return;
  }
  if (e.key !== 'Tab' || !activeModalBackdrop) return;
  const modal = activeModalBackdrop.querySelector('.modal');
  const focusable = getFocusable(modal);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function openModal(backdrop, focusEl) {
  lastFocusedEl = document.activeElement;
  backdrop.hidden = false;
  activeModalBackdrop = backdrop;
  document.addEventListener('keydown', trapFocusHandler);
  const modal = backdrop.querySelector('.modal');
  const focusable = getFocusable(modal);
  (focusEl || focusable[0] || modal).focus({ preventScroll: true });
}

function closeActiveModal() {
  if (!activeModalBackdrop) return;
  activeModalBackdrop.hidden = true;
  document.removeEventListener('keydown', trapFocusHandler);
  activeModalBackdrop = null;
  if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') lastFocusedEl.focus();
}

document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeActiveModal();
  });
  backdrop.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeActiveModal());
  });
});

/* ================================ Рендер ==================================== */

function matchesSearch(text) {
  if (!ui.searchTerm) return true;
  return text.toLowerCase().includes(ui.searchTerm.toLowerCase());
}

function renderCoverFallback(title) {
  const letter = (title || '?').trim().charAt(0).toUpperCase() || '?';
  return `<div class="card__cover-fallback">${escapeHtml(letter)}</div>`;
}

function plainTextFromHtml(html) {
  const container = document.createElement('div');
  container.innerHTML = html || '';
  return container.textContent || '';
}

function colorDotHtml(color) {
  return color ? `<span class="color-dot" style="--dot-color:${escapeHtml(color)}"></span>` : '';
}

function render() {
  if (ui.view === 'categories') {
    el.categoriesView.hidden = false;
    el.programsView.hidden = true;
    el.subbar.hidden = true;
    el.searchInput.placeholder = 'Поиск по категориям…';
    renderCategories();
  } else {
    el.categoriesView.hidden = true;
    el.programsView.hidden = false;
    el.subbar.hidden = false;
    el.searchInput.placeholder = 'Поиск по программам…';
    renderPrograms();
  }
}

function renderCategories() {
  const list = [...store.categories].sort((a, b) => a.order - b.order);
  const filtered = list.filter((c) => matchesSearch(c.name));

  el.categoriesGrid.innerHTML = '';
  el.categoriesEmpty.hidden = list.length !== 0;
  el.categoriesEmpty.querySelector('p').textContent =
    list.length === 0 ? 'Пока пусто. Создайте первую категорию.' : 'Ничего не найдено.';
  if (list.length !== 0 && filtered.length === 0) el.categoriesEmpty.hidden = false;

  filtered.forEach((cat, i) => {
    const card = document.createElement('article');
    card.className = 'card card--category';
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');
    card.dataset.id = cat.id;
    card.draggable = true;
    card.style.animationDelay = `${Math.min(i, 12) * 60}ms`;

    card.innerHTML = `
      <div class="card__accent" style="background:${cat.color ? escapeHtml(cat.color) : 'transparent'}"></div>
      <div class="card__drag" aria-hidden="true" title="Перетащить">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="4" cy="3" r="1.3" fill="currentColor"/><circle cx="10" cy="3" r="1.3" fill="currentColor"/><circle cx="4" cy="7" r="1.3" fill="currentColor"/><circle cx="10" cy="7" r="1.3" fill="currentColor"/><circle cx="4" cy="11" r="1.3" fill="currentColor"/><circle cx="10" cy="11" r="1.3" fill="currentColor"/></svg>
      </div>
      <div class="card__actions">
        <button class="card__action" data-action="edit" aria-label="Редактировать категорию">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9.5 1.5 12.5 4.5 4.5 12.5 1 13l0.5-3.5L9.5 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
        </button>
        <button class="card__action card__action--danger" data-action="delete" aria-label="Удалить категорию">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 4h9M5.5 4V2.5h3V4M3.5 4l0.5 8.5h6L10.5 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="card__body">
        <h3 class="card__title">${colorDotHtml(cat.color)}${escapeHtml(cat.name)}</h3>
        <span class="card__count">${cat.programs.length} ${pluralPrograms(cat.programs.length)}</span>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      openCategory(cat.id);
    });
    card.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-action]')) {
        e.preventDefault();
        openCategory(cat.id);
      }
    });
    card.querySelector('[data-action="edit"]').addEventListener('click', () => openCategoryModal(cat.id));
    card.querySelector('[data-action="delete"]').addEventListener('click', () =>
      confirmDelete(`Удалить категорию «${cat.name}»?`, 'Все программы внутри тоже будут удалены безвозвратно.', () =>
        store.deleteCategory(cat.id)
      )
    );

    attachDragHandlers(card, {
      onDrop: (fromId, toId) => store.reorderCategories(fromId, toId),
    });

    el.categoriesGrid.appendChild(card);
  });
}

function pluralPrograms(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'программа';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'программы';
  return 'программ';
}

function openCategory(id) {
  ui.currentCategoryId = id;
  ui.view = 'programs';
  ui.searchTerm = '';
  el.searchInput.value = '';
  const cat = store.getCategory(id);
  el.categoryTitle.textContent = cat ? cat.name : '';
  render();
}

function renderPrograms() {
  const cat = store.getCategory(ui.currentCategoryId);
  if (!cat) { ui.view = 'categories'; render(); return; }
  el.categoryTitle.textContent = cat.name;

  const filtered = cat.programs.filter((p) => matchesSearch(p.title));
  el.programsGrid.innerHTML = '';
  el.programsEmpty.hidden = cat.programs.length !== 0;
  el.programsEmpty.querySelector('p').textContent =
    cat.programs.length === 0 ? 'В этой категории пока нет программ.' : 'Ничего не найдено.';
  if (cat.programs.length !== 0 && filtered.length === 0) el.programsEmpty.hidden = false;

  filtered.forEach((prog, i) => {
    const card = document.createElement('article');
    card.className = 'card card--program';
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');
    card.dataset.id = prog.id;
    card.draggable = true;
    card.style.animationDelay = `${Math.min(i, 12) * 60}ms`;

    const coverUrl = getCachedImageUrl(prog.coverId);
    const coverHtml = coverUrl
      ? `<img class="card__cover" src="${coverUrl}" alt="">`
      : renderCoverFallback(prog.title);
    const effectiveColor = prog.color || cat.color || null;

    card.innerHTML = `
      <div class="card__accent" style="background:${effectiveColor ? escapeHtml(effectiveColor) : 'transparent'}"></div>
      <div class="card__drag" aria-hidden="true" title="Перетащить">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="4" cy="3" r="1.3" fill="currentColor"/><circle cx="10" cy="3" r="1.3" fill="currentColor"/><circle cx="4" cy="7" r="1.3" fill="currentColor"/><circle cx="10" cy="7" r="1.3" fill="currentColor"/><circle cx="4" cy="11" r="1.3" fill="currentColor"/><circle cx="10" cy="11" r="1.3" fill="currentColor"/></svg>
      </div>
      <div class="card__actions">
        <button class="card__action" data-action="edit" aria-label="Редактировать программу">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9.5 1.5 12.5 4.5 4.5 12.5 1 13l0.5-3.5L9.5 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
        </button>
        <button class="card__action card__action--danger" data-action="delete" aria-label="Удалить программу">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 4h9M5.5 4V2.5h3V4M3.5 4l0.5 8.5h6L10.5 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      ${coverHtml}
      <div class="card__body">
        <h3 class="card__title">${escapeHtml(prog.title)}</h3>
        <p class="card__meta">${colorDotHtml(prog.color)}${escapeHtml(plainTextFromHtml(prog.contentHtml).slice(0, 60))}</p>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      openProgramView(prog.id);
    });
    card.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-action]')) {
        e.preventDefault();
        openProgramView(prog.id);
      }
    });
    card.querySelector('[data-action="edit"]').addEventListener('click', () => openProgramModal(prog.id));
    card.querySelector('[data-action="delete"]').addEventListener('click', () =>
      confirmDelete(`Удалить программу «${prog.title}»?`, 'Это действие нельзя отменить.', () =>
        store.deleteProgram(ui.currentCategoryId, prog.id)
      )
    );

    attachDragHandlers(card, {
      onDrop: (fromId, toId) => store.reorderPrograms(ui.currentCategoryId, fromId, toId),
    });

    el.programsGrid.appendChild(card);
  });
}

/* ============================ Drag & drop сортировка ======================= */

function attachDragHandlers(cardEl, { onDrop }) {
  cardEl.addEventListener('dragstart', (e) => {
    ui.draggedId = cardEl.dataset.id;
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', cardEl.dataset.id); } catch {}
  });
  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
    ui.draggedId = null;
  });
  cardEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (ui.draggedId && ui.draggedId !== cardEl.dataset.id) cardEl.classList.add('drag-over');
  });
  cardEl.addEventListener('dragleave', () => cardEl.classList.remove('drag-over'));
  cardEl.addEventListener('drop', (e) => {
    e.preventDefault();
    cardEl.classList.remove('drag-over');
    const fromId = ui.draggedId;
    const toId = cardEl.dataset.id;
    if (fromId && toId && fromId !== toId) {
      onDrop(fromId, toId);
      render();
    }
  });
}

/* ============================ Модалка категории ============================ */

function openCategoryModal(categoryId = null) {
  ui.editingCategoryId = categoryId;
  const cat = categoryId ? store.getCategory(categoryId) : null;
  el.categoryModalTitle.textContent = cat ? 'Редактировать категорию' : 'Новая категория';
  el.categoryNameInput.value = cat ? cat.name : '';
  ui.selectedCategoryColor = cat ? cat.color : null;
  renderColorSwatches(el.categoryColorSwatches, ui.selectedCategoryColor, (value) => {
    ui.selectedCategoryColor = value;
  });
  openModal(el.categoryModalBackdrop, el.categoryNameInput);
}

el.categoryForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el.categoryNameInput.value.trim();
  if (!name) return;
  if (ui.editingCategoryId) {
    store.updateCategory(ui.editingCategoryId, name, ui.selectedCategoryColor);
  } else {
    store.addCategory(name, ui.selectedCategoryColor);
  }
  closeActiveModal();
  render();
});

/* ============================ Модалка программы ============================ */

function populateCategorySelect(selectedId) {
  el.programCategorySelect.innerHTML = '';
  [...store.categories].sort((a, b) => a.order - b.order).forEach((cat) => {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.name;
    if (cat.id === selectedId) opt.selected = true;
    el.programCategorySelect.appendChild(opt);
  });
}

function setEditorEmptyState() {
  const isEmpty = el.programEditor.textContent.trim() === '' && !el.programEditor.querySelector('img');
  el.programEditor.classList.toggle('is-empty', isEmpty);
}

// <h3> и <p> по спецификации HTML не могут содержать блочные элементы (списки,
// другие абзацы/заголовки) — но у execCommand в contenteditable есть баги,
// из-за которых такие блоки иногда оказываются ВНУТРИ них. Поднимаем наружу.
function hoistInvalidHeadingChildren(root) {
  root.querySelectorAll('h3, p').forEach((container) => {
    let anchor = container;
    Array.from(container.querySelectorAll(':scope > ul, :scope > ol, :scope > p, :scope > div, :scope > h3')).forEach((blk) => {
      anchor.after(blk);
      anchor = blk;
    });
  });
}

function resetProgramForm() {
  el.programTitleInput.value = '';
  el.programEditor.innerHTML = '';
  setEditorEmptyState();
  el.coverPreview.hidden = true;
  el.coverPreview.src = '';
  el.dropzoneHint.hidden = false;
  el.removeCoverBtn.hidden = true;
  el.coverFileInput.value = '';
  ui.pendingCoverBlob = null;
  ui.pendingCoverId = null;
  ui.removeCoverFlag = false;
  ui.selectedProgramColor = null;
}

function openProgramModal(programId = null) {
  ui.editingProgramId = programId;
  resetProgramForm();
  const cat = store.getCategory(ui.currentCategoryId);
  const prog = programId && cat ? cat.programs.find((p) => p.id === programId) : null;

  populateCategorySelect(ui.currentCategoryId);

  el.programModalTitle.textContent = prog ? 'Редактировать программу' : 'Новая программа';
  ui.selectedProgramColor = prog ? prog.color : null;
  renderColorSwatches(el.programColorSwatches, ui.selectedProgramColor, (value) => {
    ui.selectedProgramColor = value;
  });

  if (prog) {
    el.programTitleInput.value = prog.title;
    el.programEditor.innerHTML = hydrateForDisplay(prog.contentHtml || '');
    setEditorEmptyState();
    if (prog.coverId) {
      ui.pendingCoverId = prog.coverId;
      const url = getCachedImageUrl(prog.coverId);
      if (url) {
        el.coverPreview.src = url;
        el.coverPreview.hidden = false;
        el.dropzoneHint.hidden = true;
        el.removeCoverBtn.hidden = false;
      }
    }
  }
  openModal(el.programModalBackdrop, el.programTitleInput);
}

async function handleCoverFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const blob = await resizeImageToBlob(file);
    ui.pendingCoverBlob = blob;
    ui.removeCoverFlag = false;
    const url = URL.createObjectURL(blob);
    el.coverPreview.src = url;
    el.coverPreview.hidden = false;
    el.dropzoneHint.hidden = true;
    el.removeCoverBtn.hidden = false;
  } catch (err) {
    console.error(err);
    alert('Не удалось загрузить изображение. Попробуйте другой файл.');
  }
}

el.dropzone.addEventListener('click', (e) => {
  if (e.target.closest('.dropzone__remove')) return;
  el.coverFileInput.click();
});
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    el.coverFileInput.click();
  }
});
el.coverFileInput.addEventListener('change', () => {
  const file = el.coverFileInput.files[0];
  handleCoverFile(file);
});
['dragenter', 'dragover'].forEach((evt) =>
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('drag-active');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('drag-active');
  })
);
el.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  handleCoverFile(file);
});
el.removeCoverBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  ui.pendingCoverBlob = null;
  ui.pendingCoverId = null;
  ui.removeCoverFlag = true;
  el.coverPreview.hidden = true;
  el.coverPreview.src = '';
  el.dropzoneHint.hidden = false;
  el.removeCoverBtn.hidden = true;
  el.coverFileInput.value = '';
});

/* ---- Редактор текста программы (форматирование + вставка фото) ---- */

document.querySelectorAll('.editor__btn[data-cmd]').forEach((btn) => {
  btn.addEventListener('click', () => {
    el.programEditor.focus();
    document.execCommand(btn.dataset.cmd, false, btn.dataset.value || undefined);
    updateEditorToolbarState();
    setEditorEmptyState();
  });
});

function updateEditorToolbarState() {
  document.querySelectorAll('.editor__btn[data-cmd]').forEach((btn) => {
    const cmd = btn.dataset.cmd;
    let active = false;
    try {
      if (cmd === 'formatBlock') {
        active = document.queryCommandValue('formatBlock').toLowerCase() === 'h3';
      } else {
        active = document.queryCommandState(cmd);
      }
    } catch { /* игнорируем неподдерживаемые команды */ }
    btn.classList.toggle('is-active', active);
  });
}

el.programEditor.addEventListener('keyup', updateEditorToolbarState);
el.programEditor.addEventListener('mouseup', updateEditorToolbarState);
el.programEditor.addEventListener('input', () => {
  hoistInvalidHeadingChildren(el.programEditor);
  setEditorEmptyState();
});

// Chrome по умолчанию иногда переносит строку внутри <div> — фиксируем <p>,
// иначе такие блоки не попадают под стили .editor__area p / .view-text p
el.programEditor.addEventListener('focus', () => {
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* noop */ }
});

// Enter в конце заголовка у Chrome иногда не выходит из <h3>, а просто переносит
// строку внутри него — из-за этого список/абзац после заголовка ломает структуру.
// Принудительно создаём новый абзац сразу после заголовка.
el.programEditor.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const node = sel.getRangeAt(0).startContainer;
  const heading = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest('h3');
  if (!heading || !el.programEditor.contains(heading)) return;
  e.preventDefault();
  const p = document.createElement('p');
  p.innerHTML = '<br>';
  heading.after(p);
  const range = document.createRange();
  range.setStart(p, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  setEditorEmptyState();
});

async function insertImageIntoEditor(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const blob = await resizeImageToBlob(file, 900, 0.85);
    const id = makeId('img');
    await setImageForCover(id, blob);
    const url = getCachedImageUrl(id);
    el.programEditor.focus();
    document.execCommand('insertHTML', false, `<img src="${url}" data-cover-id="${id}" alt="">`);
    setEditorEmptyState();
  } catch (err) {
    console.error(err);
    alert('Не удалось вставить изображение.');
  }
}

document.getElementById('editorImageBtn').addEventListener('click', () => el.editorImageInput.click());
el.editorImageInput.addEventListener('change', async () => {
  const files = Array.from(el.editorImageInput.files || []);
  for (const file of files) await insertImageIntoEditor(file);
  el.editorImageInput.value = '';
});
el.programEditor.addEventListener('dragover', (e) => e.preventDefault());
el.programEditor.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
  for (const file of files) await insertImageIntoEditor(file);
});
el.programEditor.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find((it) => it.type.startsWith('image/'));
  if (imageItem) {
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (file) await insertImageIntoEditor(file);
    return;
  }
  // Вставляем ТОЛЬКО как обычный текст. Если разрешить вставку чужой разметки
  // (например, таблицы из документа или сайта), санитайзер при сохранении
  // выбросит теги table/tr/td как неизвестные — и текст ячеек схлопнется
  // в одну строку без разделителей. Явный insertText этого не допускает.
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  if (text) {
    document.execCommand('insertText', false, text);
    hoistInvalidHeadingChildren(el.programEditor);
    setEditorEmptyState();
  }
});

/* ---- Санитайзинг и подготовка HTML текста программы к хранению/показу ---- */

const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'P', 'DIV', 'UL', 'OL', 'LI', 'H3', 'IMG']);

function sanitizeEditorHtml(html) {
  const container = document.createElement('div');
  container.innerHTML = html || '';
  const walk = (node) => {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (!ALLOWED_TAGS.has(child.tagName)) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          return;
        }
        Array.from(child.attributes).forEach((attr) => {
          const keep = child.tagName === 'IMG' && (attr.name === 'data-cover-id' || attr.name === 'alt');
          if (!keep) child.removeAttribute(attr.name);
        });
        walk(child);
      } else if (child.nodeType !== Node.TEXT_NODE) {
        node.removeChild(child);
      }
    });
  };
  walk(container);
  hoistInvalidHeadingChildren(container);
  // браузер сам «расплетает» невалидную вложенность (например <p><ul>…</ul></p>)
  // при парсинге innerHTML выше, но оставляет пустые p/div-обрубки — убираем их
  container.querySelectorAll('p, div').forEach((elm) => {
    if (elm.innerHTML.trim() === '') elm.remove();
  });
  // src не храним — при показе подставляем актуальный object URL по data-cover-id
  container.querySelectorAll('img[data-cover-id]').forEach((img) => img.removeAttribute('src'));
  return container.innerHTML;
}

function hydrateForDisplay(html) {
  const container = document.createElement('div');
  container.innerHTML = html || '';
  container.querySelectorAll('img[data-cover-id]').forEach((img) => {
    const url = getCachedImageUrl(img.getAttribute('data-cover-id'));
    if (url) img.setAttribute('src', url);
  });
  return container.innerHTML;
}

el.programForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = el.programTitleInput.value.trim();
  if (!title) return;

  const targetCategoryId = el.programCategorySelect.value;
  const sourceCat = store.getCategory(ui.currentCategoryId);
  const targetCat = store.getCategory(targetCategoryId);
  if (!sourceCat || !targetCat) return;

  let coverId = ui.pendingCoverId;
  if (ui.pendingCoverBlob) {
    coverId = coverId || makeId('cover');
    await setImageForCover(coverId, ui.pendingCoverBlob);
  } else if (ui.removeCoverFlag && ui.editingProgramId) {
    const existing = sourceCat.programs.find((p) => p.id === ui.editingProgramId);
    if (existing && existing.coverId) await removeCoverImage(existing.coverId);
    coverId = null;
  }

  const contentHtml = sanitizeEditorHtml(el.programEditor.innerHTML);

  // удаляем изображения текста, которые пользователь убрал при редактировании
  if (ui.editingProgramId) {
    const existing = sourceCat.programs.find((p) => p.id === ui.editingProgramId);
    if (existing) {
      const oldIds = extractImageIds(existing.contentHtml);
      const newIds = extractImageIds(contentHtml);
      for (const id of oldIds) if (!newIds.includes(id)) await removeCoverImage(id);
    }
  }

  const patch = { title, color: ui.selectedProgramColor, coverId, contentHtml };

  if (ui.editingProgramId) {
    if (targetCategoryId !== ui.currentCategoryId) {
      store.moveProgram(ui.currentCategoryId, targetCategoryId, ui.editingProgramId, patch);
      ui.currentCategoryId = targetCategoryId; // переходим вслед за программой
    } else {
      store.updateProgram(ui.currentCategoryId, ui.editingProgramId, patch);
    }
  } else {
    store.addProgram(targetCategoryId, patch);
    ui.currentCategoryId = targetCategoryId;
  }

  closeActiveModal();
  const cat = store.getCategory(ui.currentCategoryId);
  el.categoryTitle.textContent = cat ? cat.name : '';
  render();
});

/* ============================ Просмотр программы =========================== */

function openProgramView(programId) {
  const cat = store.getCategory(ui.currentCategoryId);
  const prog = cat && cat.programs.find((p) => p.id === programId);
  if (!prog) return;
  el.viewModalTitle.textContent = prog.title;
  el.viewModalText.innerHTML = hydrateForDisplay(prog.contentHtml || '');
  const url = getCachedImageUrl(prog.coverId);
  if (url) {
    el.viewCoverImg.src = url;
    el.viewCoverImg.hidden = false;
  } else {
    el.viewCoverImg.hidden = true;
    el.viewCoverImg.src = '';
  }
  openModal(el.viewModalBackdrop);
}

/* ============================ Подтверждение удаления ======================== */

function confirmDelete(title, text, onConfirm) {
  el.confirmModalTitle.textContent = title;
  el.confirmModalText.textContent = text;
  const handler = () => {
    onConfirm();
    closeActiveModal();
    render();
    el.confirmDeleteBtn.removeEventListener('click', handler);
  };
  el.confirmDeleteBtn.addEventListener('click', handler);
  openModal(el.confirmModalBackdrop);
}

/* ================================= Поиск ===================================== */

el.searchInput.addEventListener('input', () => {
  ui.searchTerm = el.searchInput.value.trim();
  render();
});

/* ============================ Навигация и общие кнопки ======================= */

el.backBtn.addEventListener('click', () => {
  ui.view = 'categories';
  ui.currentCategoryId = null;
  ui.searchTerm = '';
  el.searchInput.value = '';
  render();
});
el.brandBtn.addEventListener('click', () => {
  ui.view = 'categories';
  ui.currentCategoryId = null;
  ui.searchTerm = '';
  el.searchInput.value = '';
  render();
});

el.fabBtn.addEventListener('click', () => {
  if (ui.view === 'categories') {
    openCategoryModal(null);
  } else {
    openProgramModal(null);
  }
});

/* ============================ Экспорт / импорт JSON ========================== */

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(dataUrl) {
  return fetch(dataUrl).then((r) => r.blob());
}

el.exportBtn.addEventListener('click', async () => {
  const allImages = await idbGetAllImages();
  const exportCategories = [];
  for (const cat of store.categories) {
    const programs = [];
    for (const prog of cat.programs) {
      let coverData = null;
      if (prog.coverId && allImages.has(prog.coverId)) {
        coverData = await blobToBase64(allImages.get(prog.coverId));
      }
      const contentImages = {};
      for (const id of extractImageIds(prog.contentHtml)) {
        if (allImages.has(id)) contentImages[id] = await blobToBase64(allImages.get(id));
      }
      programs.push({
        id: prog.id, title: prog.title, color: prog.color || null,
        contentHtml: prog.contentHtml, coverData, contentImages,
      });
    }
    exportCategories.push({ id: cat.id, name: cat.name, color: cat.color || null, order: cat.order, programs });
  }
  const payload = { app: 'White Room', version: 2, exportedAt: new Date().toISOString(), categories: exportCategories };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `white-room-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

el.importBtn.addEventListener('click', () => el.importFile.click());

el.importFile.addEventListener('change', async () => {
  const file = el.importFile.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.categories)) throw new Error('Некорректный файл');

    const ok = confirm('Импорт заменит текущие данные библиотеки. Продолжить?');
    if (!ok) { el.importFile.value = ''; return; }

    // очищаем текущие изображения
    const existingImages = await idbGetAllImages();
    for (const id of existingImages.keys()) await idbDeleteImage(id);
    imageUrlCache.forEach((url) => URL.revokeObjectURL(url));
    imageUrlCache.clear();

    const newCategories = [];
    for (const cat of data.categories) {
      const programs = [];
      for (const prog of cat.programs || []) {
        let coverId = null;
        if (prog.coverData) {
          coverId = makeId('cover');
          await setImageForCover(coverId, await base64ToBlob(prog.coverData));
        }

        let contentHtml = prog.contentHtml != null ? prog.contentHtml : textToContentHtml(prog.description || '');
        if (prog.contentImages) {
          for (const [oldId, base64] of Object.entries(prog.contentImages)) {
            const newId = makeId('img');
            await setImageForCover(newId, await base64ToBlob(base64));
            contentHtml = contentHtml.split(`data-cover-id="${oldId}"`).join(`data-cover-id="${newId}"`);
          }
        }

        programs.push({
          id: prog.id || makeId('prog'),
          title: prog.title || 'Без названия',
          color: prog.color || null,
          coverId,
          contentHtml,
        });
      }
      newCategories.push({
        id: cat.id || makeId('cat'),
        name: cat.name || 'Без названия',
        color: cat.color || null,
        order: typeof cat.order === 'number' ? cat.order : newCategories.length,
        programs,
      });
    }
    store.categories = newCategories;
    store.save();
    ui.view = 'categories';
    ui.currentCategoryId = null;
    render();
    alert('Импорт завершён.');
  } catch (err) {
    console.error(err);
    alert('Не удалось импортировать файл. Проверьте, что это корректный JSON-бэкап White Room.');
  } finally {
    el.importFile.value = '';
  }
});

/* ============================ Цитаты на экране-заставке ======================
   Оригинальные короткие реплики, написанные в характере и тоне персонажа
   Аянокоджи Киётаки (стилизация, а не дословные цитаты источника).
   ========================================================================= */

const INTRO_QUOTES = [
  'Способности не измеряются желанием — только результатом.',
  'Слабость — это не черта характера. Это диагноз, который можно исправить.',
  'Я не сужу людей. Я просто фиксирую переменные.',
  'Комната без окон учит одному: то, что снаружи, не решает твою ценность.',
  'Эмоции — это шум. Тишина эффективнее.',
  'Я не одинок. Одиночество подразумевает, что кому-то есть до этого дело.',
  'Мир не делится на добрых и злых. Он делится на полезных и лишних.',
  'Меня не нужно понимать. Меня нужно либо превзойти, либо не мешать.',
  'Если план работает без эмоций — он работает лучше.',
  'Я не боюсь одиночества. Я вырос в комнате, где оно было единственной константой.',
  'Слёзы ничего не доказывают, кроме того, что человек ещё не понял правил игры.',
  'Контроль над собой — единственная свобода, которую нельзя отнять.',
  'Меня учили не побеждать. Меня учили не проигрывать. Это разные вещи.',
  'Я наблюдаю дольше, чем действую. Действие — последний шаг, а не первый.',
  'Идеальный результат не требует свидетелей.',
  'Белые стены не пугают. Пугает то, что за ними никто не ждёт тебя обратно.',
  'Я не притворяюсь равнодушным. Я просто не вижу повода быть другим.',
  'Каждый человек — это система. Нужно только найти входные данные.',
  'Единственное, что имеет значение, — способен ты или нет. Остальное — оправдания.',
  'Я не помню, когда в последний раз хотел, чтобы меня заметили. Возможно, никогда.',
  'Если тебя можно сломать словами, ты ещё не начинал тренироваться.',
  'Я не мщу. Месть — это трата ресурсов на то, что уже не имеет значения.',
  'Одобрение — валюта, которая мне не нужна.',
  'В комнате без цвета быстро учишься видеть оттенки, которые другие не замечают.',
  'Я не выбирал быть таким. Но перестал жалеть об этом уже давно.',
  'Люди боятся тишины — в ней слышно, насколько они зависят от чужого одобрения.',
  'Победа без усилий — это не везение. Это подготовка, которую никто не видел.',
  'Меня можно недооценить только один раз.',
  'Сострадание — это инструмент, а не обязанность.',
  'Я не ищу друзей. Я ищу тех, кто не подведёт в нужный момент.',
  'Боль — это просто информация о пределах системы.',
  'Комфорт делает человека предсказуемым. Предсказуемость делает его уязвимым.',
  'Я не спорю с глупостью. Я просто перестаю тратить на неё время.',
  'Если результат достигнут, неважно, поверил в тебя кто-то или нет.',
  'Меня спрашивают, что я чувствую. Я отвечаю: то, что нужно для результата.',
  'Пустая комната учит терпению лучше, чем любые слова.',
  'Я не жду аплодисментов. Я жду конца необходимости доказывать очевидное.',
  'Слабые ищут причины. Сильные — методы.',
  'Я не измеряю дни. Я измеряю то, чему успел научиться за них.',
  'Свобода — это не отсутствие стен. Это безразличие к тому, что они есть.',
];

function showIntroScreen() {
  const quote = INTRO_QUOTES[Math.floor(Math.random() * INTRO_QUOTES.length)];
  const sessionNo = String(Math.floor(100 + Math.random() * 900));
  el.introKicker.textContent = `БЕЛАЯ КОМНАТА · ЗАПИСЬ №${sessionNo}`;
  el.introQuote.textContent = quote;

  const dismiss = () => {
    el.introScreen.classList.add('is-hidden');
    document.removeEventListener('keydown', onKey);
  };
  const onKey = () => dismiss();

  el.introEnterBtn.addEventListener('click', dismiss, { once: true });
  el.introScreen.addEventListener('click', (e) => {
    if (e.target === el.introScreen) dismiss();
  }, { once: true });
  document.addEventListener('keydown', onKey, { once: true });
}

/* ================================ Инициализация ============================== */

async function init() {
  store.load();
  await preloadAllImages();
  render();
  showIntroScreen();
}

init();
