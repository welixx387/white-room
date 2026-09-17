'use strict';

/* =========================================================================
   White Room — личная библиотека контента.
   Всё хранится локально: тексты в localStorage, обложки — в IndexedDB.
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

/* ============================ IndexedDB слой ============================
   Храним обложки как Blob в IndexedDB (localStorage слишком мал для картинок).
   В основном JSON (localStorage) программы хранят только ссылку coverId.
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

// Сжимаем изображение до ширины ~800px через canvas и возвращаем Blob (JPEG)
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
const imageUrlCache = new Map(); // coverId -> object URL

function getCachedImageUrl(coverId) {
  return coverId ? imageUrlCache.get(coverId) || null : null;
}

async function preloadAllImages() {
  const all = await idbGetAllImages();
  for (const [id, blob] of all.entries()) {
    imageUrlCache.set(id, URL.createObjectURL(blob));
  }
}

async function setImageForCover(coverId, blob) {
  await idbPutImage(coverId, blob);
  const old = imageUrlCache.get(coverId);
  if (old) URL.revokeObjectURL(old);
  imageUrlCache.set(coverId, URL.createObjectURL(blob));
}

async function removeCoverImage(coverId) {
  if (!coverId) return;
  await idbDeleteImage(coverId);
  const old = imageUrlCache.get(coverId);
  if (old) URL.revokeObjectURL(old);
  imageUrlCache.delete(coverId);
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
  },

  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.categories));
    notifySaved();
  },

  getCategory(id) {
    return this.categories.find((c) => c.id === id) || null;
  },

  addCategory(name) {
    const cat = { id: makeId('cat'), name, order: this.categories.length, programs: [] };
    this.categories.push(cat);
    this.save();
    return cat;
  },

  updateCategory(id, name) {
    const cat = this.getCategory(id);
    if (!cat) return;
    cat.name = name;
    this.save();
  },

  deleteCategory(id) {
    const cat = this.getCategory(id);
    if (!cat) return;
    // удаляем все обложки программ этой категории
    cat.programs.forEach((p) => { if (p.coverId) removeCoverImage(p.coverId); });
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

  addProgram(categoryId, { title, description, coverId }) {
    const cat = this.getCategory(categoryId);
    if (!cat) return null;
    const prog = { id: makeId('prog'), title, description, coverId: coverId || null };
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

  deleteProgram(categoryId, programId) {
    const cat = this.getCategory(categoryId);
    if (!cat) return;
    const prog = cat.programs.find((p) => p.id === programId);
    if (prog && prog.coverId) removeCoverImage(prog.coverId);
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
  editingCategoryId: null,   // если задано — модалка категории в режиме редактирования
  editingProgramId: null,    // если задано — модалка программы в режиме редактирования
  pendingCoverBlob: null,    // выбранная (ещё не сохранённая) обложка для формы программы
  pendingCoverId: null,      // id существующей обложки при редактировании
  removeCoverFlag: false,    // пользователь явно удалил обложку в форме
  draggedId: null,
};

/* ================================ DOM ссылки =============================== */

const el = {
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

  programModalBackdrop: document.getElementById('programModalBackdrop'),
  programModal: document.getElementById('programModal'),
  programForm: document.getElementById('programForm'),
  programModalTitle: document.getElementById('programModalTitle'),
  programTitleInput: document.getElementById('programTitleInput'),
  programDescInput: document.getElementById('programDescInput'),
  dropzone: document.getElementById('dropzone'),
  dropzoneHint: document.getElementById('dropzoneHint'),
  coverPreview: document.getElementById('coverPreview'),
  coverFileInput: document.getElementById('coverFileInput'),
  removeCoverBtn: document.getElementById('removeCoverBtn'),

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
        <h3 class="card__title">${escapeHtml(cat.name)}</h3>
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

    card.innerHTML = `
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
        <p class="card__meta">${escapeHtml((prog.description || '').slice(0, 60))}</p>
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
  openModal(el.categoryModalBackdrop, el.categoryNameInput);
}

el.categoryForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el.categoryNameInput.value.trim();
  if (!name) return;
  if (ui.editingCategoryId) {
    store.updateCategory(ui.editingCategoryId, name);
  } else {
    store.addCategory(name);
  }
  closeActiveModal();
  render();
});

/* ============================ Модалка программы ============================ */

function resetProgramForm() {
  el.programTitleInput.value = '';
  el.programDescInput.value = '';
  el.coverPreview.hidden = true;
  el.coverPreview.src = '';
  el.dropzoneHint.hidden = false;
  el.removeCoverBtn.hidden = true;
  el.coverFileInput.value = '';
  ui.pendingCoverBlob = null;
  ui.pendingCoverId = null;
  ui.removeCoverFlag = false;
}

function openProgramModal(programId = null) {
  ui.editingProgramId = programId;
  resetProgramForm();
  const cat = store.getCategory(ui.currentCategoryId);
  const prog = programId && cat ? cat.programs.find((p) => p.id === programId) : null;

  el.programModalTitle.textContent = prog ? 'Редактировать программу' : 'Новая программа';
  if (prog) {
    el.programTitleInput.value = prog.title;
    el.programDescInput.value = prog.description || '';
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

el.programForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = el.programTitleInput.value.trim();
  const description = el.programDescInput.value; // переносы строк сохраняются как есть
  if (!title) return;

  const cat = store.getCategory(ui.currentCategoryId);
  if (!cat) return;

  let coverId = ui.pendingCoverId;

  // если пользователь выбрал новый файл — сохраняем его в IndexedDB
  if (ui.pendingCoverBlob) {
    coverId = coverId || makeId('cover');
    await setImageForCover(coverId, ui.pendingCoverBlob);
  } else if (ui.removeCoverFlag && ui.editingProgramId) {
    const existing = cat.programs.find((p) => p.id === ui.editingProgramId);
    if (existing && existing.coverId) await removeCoverImage(existing.coverId);
    coverId = null;
  }

  if (ui.editingProgramId) {
    store.updateProgram(ui.currentCategoryId, ui.editingProgramId, { title, description, coverId });
  } else {
    store.addProgram(ui.currentCategoryId, { title, description, coverId });
  }

  closeActiveModal();
  render();
});

/* ============================ Просмотр программы =========================== */

function openProgramView(programId) {
  const cat = store.getCategory(ui.currentCategoryId);
  const prog = cat && cat.programs.find((p) => p.id === programId);
  if (!prog) return;
  el.viewModalTitle.textContent = prog.title;
  el.viewModalText.textContent = prog.description || '';
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
      programs.push({ id: prog.id, title: prog.title, description: prog.description, coverData });
    }
    exportCategories.push({ id: cat.id, name: cat.name, order: cat.order, programs });
  }
  const payload = { app: 'White Room', version: 1, exportedAt: new Date().toISOString(), categories: exportCategories };
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

    // очищаем текущие обложки
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
          const blob = await base64ToBlob(prog.coverData);
          await setImageForCover(coverId, blob);
        }
        programs.push({
          id: prog.id || makeId('prog'),
          title: prog.title || 'Без названия',
          description: prog.description || '',
          coverId,
        });
      }
      newCategories.push({
        id: cat.id || makeId('cat'),
        name: cat.name || 'Без названия',
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

/* ================================ Инициализация ============================== */

async function init() {
  store.load();
  await preloadAllImages();
  render();
}

init();
