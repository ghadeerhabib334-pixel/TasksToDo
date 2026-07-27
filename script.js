(() => {
  'use strict';

  const STORAGE_KEY = 'field-work-map-project-v1';
  const ROMANIA_VIEW = { center: [45.9432, 24.9668], zoom: 7 };
  const TYPES = ['Camera', 'Radar', 'Cabinet', 'Switch', 'Fiber', 'Other'];
  const TYPE_SYMBOLS = { Camera: 'C', Radar: 'R', Cabinet: 'B', Switch: 'S', Fiber: 'F', Other: 'P' };
  const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const defaultProject = () => ({
    version: 1,
    map: clone(ROMANIA_VIEW),
    settings: { theme: 'system', startupView: clone(ROMANIA_VIEW) },
    markers: []
  });

  const elements = {
    addMarker: $('#add-marker-btn'), goTo: $('#go-to-btn'), goToDialog: $('#go-to-dialog'), pinList: $('#pin-list'),
    tasks: $('#tasks-btn'), taskPanel: $('#task-panel'), closeTasks: $('#close-tasks'),
    taskCount: $('#task-count'), remainingCount: $('#remaining-count'), completedCount: $('#completed-count'),
    globalTasks: $('#global-task-list'), taskSort: $('#task-sort'), search: $('#search-input'), searchResults: $('#search-results'),
    save: $('#save-btn'), open: $('#open-btn'), file: $('#file-input'), settings: $('#settings-btn'),
    mobileMenuButton: $('#mobile-menu-btn'), mobileMenu: $('#mobile-menu'), mobileTasks: $('#mobile-tasks-btn'),
    mobileGoTo: $('#mobile-go-to-btn'), mobileSave: $('#mobile-save-btn'), mobileOpen: $('#mobile-open-btn'), mobileSettings: $('#mobile-settings-btn'),
    placementBanner: $('#placement-banner'), cancelPlacement: $('#cancel-placement'), markerDialog: $('#marker-dialog'), locate: $('#locate-btn'),
    markerForm: $('#marker-form'), markerTitle: $('#marker-dialog-title'), markerName: $('#marker-name'), markerSymbol: $('#marker-symbol'),
    markerCoordinates: $('#marker-coordinates'), markerNotes: $('#marker-notes'), taskEditor: $('#task-editor'),
    linkEditor: $('#link-editor'), addTask: $('#add-task-row'), addLink: $('#add-link-row'), markerError: $('#marker-form-error'),
    taskDetailDialog: $('#task-detail-dialog'), taskDetailTitle: $('#task-detail-title'), taskDetailLocation: $('#task-detail-location'),
    taskDetailText: $('#task-detail-text'), taskDetailMap: $('#task-detail-map'),
    settingsDialog: $('#settings-dialog'), theme: $('#theme-select'), useCurrentView: $('#use-current-view'),
    resetDefaultView: $('#reset-default-view'), startupViewLabel: $('#startup-view-label'), confirm: $('#confirm-dialog'),
    confirmMessage: $('#confirm-message'), toastRegion: $('#toast-region')
  };

  let state = loadLocalProject();
  let leafletMarkers = new Map();
  let placementMode = false;
  let editorContext = null;
  let taskFilter = 'all';
  let userLocationMarker = null;
  let userAccuracyCircle = null;

  applyTheme(state.settings.theme);
  const map = L.map('map', { zoomControl: true, scrollWheelZoom: true }).setView(state.map.center, state.map.zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  }).addTo(map);

  function normalizeProject(input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.markers)) throw new Error('The file does not contain a valid markers list.');
    const project = defaultProject();
    if (input.map?.center && Array.isArray(input.map.center) && input.map.center.length === 2) {
      const lat = Number(input.map.center[0]); const lng = Number(input.map.center[1]); const zoom = Number(input.map.zoom);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(zoom)) project.map = { center: [lat, lng], zoom };
    }
    const theme = input.settings?.theme;
    if (['system', 'light', 'dark'].includes(theme)) project.settings.theme = theme;
    const startup = input.settings?.startupView;
    if (Array.isArray(startup?.center) && startup.center.length === 2 && Number.isFinite(Number(startup.zoom))) {
      project.settings.startupView = { center: startup.center.map(Number), zoom: Number(startup.zoom) };
    }
    const seenMarkers = new Set();
    project.markers = input.markers.map((raw, index) => {
      if (!raw || typeof raw !== 'object') throw new Error(`Marker ${index + 1} is invalid.`);
      const name = String(raw.name ?? '').trim(); const lat = Number(raw.lat); const lng = Number(raw.lng);
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error(`Marker ${index + 1} has an invalid name or coordinates.`);
      let id = String(raw.id ?? uid()); if (seenMarkers.has(id)) id = uid(); seenMarkers.add(id);
      const type = TYPES.includes(raw.type) ? raw.type : 'Other';
      const legacySymbol = TYPE_SYMBOLS[type];
      const rawSymbol = String(raw.symbol ?? '').trim();
      const symbol = rawSymbol && rawSymbol.length <= 12 ? rawSymbol : legacySymbol;
      const taskIds = new Set(); const linkIds = new Set();
      const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map((task) => {
        const title = String(task?.title ?? '').trim(); if (!title) return null;
        let taskId = String(task.id ?? uid()); if (taskIds.has(taskId)) taskId = uid(); taskIds.add(taskId);
        return { id: taskId, title, details: String(task.details ?? '').trim(), completed: Boolean(task.completed) };
      }).filter(Boolean);
      const links = (Array.isArray(raw.links) ? raw.links : []).map((link) => {
        const title = String(link?.title ?? '').trim(); const url = String(link?.url ?? '').trim(); if (!title || !url || !isSafeUrl(url)) return null;
        let linkId = String(link.id ?? uid()); if (linkIds.has(linkId)) linkId = uid(); linkIds.add(linkId);
        return { id: linkId, title, url };
      }).filter(Boolean);
      return { id, name, type, symbol, lat, lng, notes: String(raw.notes ?? ''), links, tasks };
    });
    return project;
  }

  function loadLocalProject() {
    try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? normalizeProject(JSON.parse(raw)) : defaultProject(); }
    catch (error) { console.warn('Could not restore local project:', error); return defaultProject(); }
  }

  let saveTimer;
  function persist({ render = true } = {}) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
      catch { toast('Could not auto-save in this browser. Use Save to export your project.'); }
    }, 80);
    if (render) renderAll();
  }

  function isSafeUrl(value) {
    const text = String(value).trim();
    if (!text || /^[a-z][a-z0-9+.-]*:/i.test(text) === false) return !text.startsWith('//');
    try { return SAFE_PROTOCOLS.has(new URL(text).protocol); } catch { return false; }
  }

  function markerColor(marker) {
    if (!marker.tasks.length) return '#d84747';
    const completed = marker.tasks.filter((task) => task.completed).length;
    if (completed === 0) return '#d84747';
    if (completed === marker.tasks.length) return '#249665';
    return '#d59b22';
  }

  function iconFor(marker) {
    return L.divIcon({
      className: 'field-marker', iconSize: [36, 42], iconAnchor: [18, 39], popupAnchor: [0, -38],
      html: `<div class="marker-pin" style="--marker-color:${markerColor(marker)}"><span>${escapeHtml(marker.symbol)}</span></div>`
    });
  }

  function renderMarkers() {
    const activeIds = new Set(state.markers.map((marker) => marker.id));
    for (const [id, layer] of leafletMarkers) if (!activeIds.has(id)) { map.removeLayer(layer); leafletMarkers.delete(id); }
    state.markers.forEach((marker) => {
      let layer = leafletMarkers.get(marker.id);
      if (!layer) {
        layer = L.marker([marker.lat, marker.lng], { icon: iconFor(marker) }).addTo(map);
        layer.on('popupopen', () => bindPopupActions(marker.id, layer));
        leafletMarkers.set(marker.id, layer);
      }
      layer.setLatLng([marker.lat, marker.lng]).setIcon(iconFor(marker)).bindPopup(popupHtml(marker), { maxWidth: 330 });
      if (layer.isPopupOpen()) {
        layer.setPopupContent(popupHtml(marker));
        bindPopupActions(marker.id, layer);
      }
    });
  }

  function popupHtml(marker) {
    const tasks = marker.tasks.length ? marker.tasks.map((task) => `<div class="popup-task"><input type="checkbox" data-task-id="${escapeAttr(task.id)}" ${task.completed ? 'checked' : ''} aria-label="Mark ${escapeAttr(task.title)} ${task.completed ? 'remaining' : 'completed'}"><button type="button" data-task-details="${escapeAttr(task.id)}" class="${task.completed ? 'done' : ''}">${escapeHtml(task.title)}</button></div>`).join('') : '<span class="popup-type">No tasks yet</span>';
    const links = marker.links.length ? marker.links.map((link) => `<a href="${escapeAttr(link.url)}" target="_blank" rel="noopener noreferrer">↗ ${escapeHtml(link.title)}</a>`).join('') : '';
    return `<div class="popup-head"><span class="type-badge">${escapeHtml(marker.symbol)}</span><div><h3>${escapeHtml(marker.name)}</h3><span class="popup-type">${escapeHtml(marker.type)}</span></div></div>
      <div class="popup-section"><h4>Tasks</h4>${tasks}</div>
      ${marker.notes ? `<div class="popup-section"><h4>Notes</h4><div class="popup-notes">${escapeHtml(marker.notes)}</div></div>` : ''}
      ${links ? `<div class="popup-section"><h4>Links</h4><div class="popup-links">${links}</div></div>` : ''}
      <div class="popup-actions"><button type="button" data-action="edit">Edit</button><button type="button" data-action="delete" class="delete">Delete</button></div>`;
  }

  function bindPopupActions(markerId, layer) {
    const root = layer.getPopup().getElement(); if (!root) return;
    $$('[data-task-id]', root).forEach((input) => input.addEventListener('change', () => toggleTask(markerId, input.dataset.taskId, input.checked)));
    $$('[data-task-details]', root).forEach((button) => button.addEventListener('click', () => openTaskDetails(markerId, button.dataset.taskDetails)));
    $('[data-action="edit"]', root)?.addEventListener('click', () => openMarkerEditor(markerId));
    $('[data-action="delete"]', root)?.addEventListener('click', () => requestDelete(markerId));
  }

  function renderTasks() {
    const all = state.markers.flatMap((marker) => marker.tasks.map((task) => ({ marker, task })));
    const completed = all.filter(({ task }) => task.completed).length;
    elements.taskCount.textContent = String(all.length - completed); elements.remainingCount.textContent = String(all.length - completed); elements.completedCount.textContent = String(completed);
    const filtered = all.filter(({ task }) => taskFilter === 'all' || (taskFilter === 'completed' ? task.completed : !task.completed));
    const sort = elements.taskSort.value;
    filtered.sort((a, b) => {
      if (sort === 'task') return a.task.title.localeCompare(b.task.title) || a.marker.name.localeCompare(b.marker.name);
      const key = sort === 'type' ? 'type' : 'name';
      return a.marker[key].localeCompare(b.marker[key]) || a.task.title.localeCompare(b.task.title);
    });
    elements.globalTasks.replaceChildren();
    if (!filtered.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = all.length ? 'No tasks match this filter.' : 'No tasks yet. Add a marker to get started.'; elements.globalTasks.append(empty); return; }
    filtered.forEach(({ marker, task }) => {
      const row = document.createElement('div'); row.className = 'global-task';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = task.completed; checkbox.setAttribute('aria-label', `Mark ${task.title} ${task.completed ? 'remaining' : 'completed'}`);
      const jump = document.createElement('button'); jump.type = 'button';
      const title = document.createElement('span'); title.textContent = task.title; if (task.completed) title.className = 'done';
      const location = document.createElement('small'); location.textContent = `⌖ ${marker.name} · ${marker.type}`; jump.append(title, location); row.append(checkbox, jump);
      checkbox.addEventListener('change', () => toggleTask(marker.id, task.id, checkbox.checked)); jump.addEventListener('click', () => openTaskDetails(marker.id, task.id));
      elements.globalTasks.append(row);
    });
  }

  function renderSearch() {
    const query = elements.search.value.trim().toLocaleLowerCase();
    if (!query) { closeSearch(); return; }
    const matches = state.markers.filter((marker) => {
      const coordinates = [
        `${marker.lat}, ${marker.lng}`,
        `${marker.lat},${marker.lng}`,
        `${marker.lat.toFixed(5)}, ${marker.lng.toFixed(5)}`,
        `${marker.lat.toFixed(5)},${marker.lng.toFixed(5)}`
      ];
      return marker.name.toLocaleLowerCase().includes(query)
        || marker.type.toLocaleLowerCase().includes(query)
        || marker.symbol.toLocaleLowerCase().includes(query)
        || coordinates.some((value) => value.toLocaleLowerCase().includes(query))
        || marker.tasks.some((task) => task.title.toLocaleLowerCase().includes(query) || task.details.toLocaleLowerCase().includes(query));
    }).slice(0, 12);
    elements.searchResults.replaceChildren();
    if (!matches.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'No locations found.'; elements.searchResults.append(empty); }
    matches.forEach((marker) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'search-result'; button.setAttribute('role', 'option');
      const badge = document.createElement('span'); badge.className = 'type-badge'; badge.textContent = marker.symbol;
      const matchingTask = marker.tasks.find((task) => task.title.toLocaleLowerCase().includes(query) || task.details.toLocaleLowerCase().includes(query));
      const copy = document.createElement('span'); const name = document.createElement('strong'); name.textContent = marker.name; const type = document.createElement('small');
      type.textContent = matchingTask ? `Task: ${matchingTask.title}` : `${marker.type} · ${marker.lat.toFixed(5)}, ${marker.lng.toFixed(5)}`;
      copy.append(name, type); button.append(badge, copy);
      button.addEventListener('click', () => { focusMarker(marker.id); elements.search.value = ''; closeSearch(); }); elements.searchResults.append(button);
    });
    elements.searchResults.hidden = false; elements.search.setAttribute('aria-expanded', 'true');
  }

  function closeSearch() { elements.searchResults.hidden = true; elements.search.setAttribute('aria-expanded', 'false'); }

  function renderPinList() {
    elements.pinList.replaceChildren();
    const markers = [...state.markers].sort((a, b) => a.name.localeCompare(b.name));
    if (!markers.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'No pins yet. Add a marker to get started.'; elements.pinList.append(empty); return;
    }
    markers.forEach((marker) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'pin-list-item';
      const badge = document.createElement('span'); badge.className = 'type-badge'; badge.textContent = marker.symbol;
      const copy = document.createElement('span'); const name = document.createElement('strong'); name.textContent = marker.name;
      const coordinates = document.createElement('small'); coordinates.textContent = `${marker.lat.toFixed(5)}, ${marker.lng.toFixed(5)}`;
      copy.append(name, coordinates); button.append(badge, copy);
      button.addEventListener('click', () => { elements.goToDialog.close(); focusMarker(marker.id); });
      elements.pinList.append(button);
    });
  }

  function renderAll() { renderMarkers(); renderTasks(); if (elements.search.value) renderSearch(); }

  function toggleTask(markerId, taskId, completed) {
    const marker = state.markers.find((item) => item.id === markerId); const task = marker?.tasks.find((item) => item.id === taskId); if (!task) return;
    const action = completed ? 'complete' : 'reactivate';
    if (!window.confirm(`Are you sure you want to ${action} “${task.title}”?`)) { renderAll(); return; }
    task.completed = completed; persist();
  }

  function focusMarker(markerId) {
    const marker = state.markers.find((item) => item.id === markerId); const layer = leafletMarkers.get(markerId); if (!marker || !layer) return;
    map.setView([marker.lat, marker.lng], Math.max(map.getZoom(), 16), { animate: true }); setTimeout(() => layer.openPopup(), 260);
  }

  function openTaskDetails(markerId, taskId) {
    const marker = state.markers.find((item) => item.id === markerId);
    const task = marker?.tasks.find((item) => item.id === taskId);
    if (!marker || !task) return;
    elements.taskDetailTitle.textContent = task.title;
    elements.taskDetailLocation.textContent = `${marker.name} · ${marker.type}`;
    elements.taskDetailText.textContent = task.details || 'No details added.';
    elements.taskDetailText.classList.toggle('empty', !task.details);
    elements.taskDetailMap.onclick = () => { elements.taskDetailDialog.close(); setTaskPanel(false); focusMarker(marker.id); };
    elements.taskDetailDialog.showModal();
  }

  function showMyLocation() {
    if (!navigator.geolocation) { toast('Location is not supported by this browser.'); return; }
    elements.locate.classList.add('locating'); elements.locate.setAttribute('aria-label', 'Finding your location');
    map.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true, timeout: 15000 });
  }

  map.on('locationfound', (event) => {
    elements.locate.classList.remove('locating'); elements.locate.setAttribute('aria-label', 'Show my location');
    if (userLocationMarker) map.removeLayer(userLocationMarker);
    if (userAccuracyCircle) map.removeLayer(userAccuracyCircle);
    userAccuracyCircle = L.circle(event.latlng, { radius: event.accuracy, color: '#1677d2', weight: 1, fillColor: '#5ca9ef', fillOpacity: .13 }).addTo(map);
    userLocationMarker = L.circleMarker(event.latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#1677d2', fillOpacity: 1 }).addTo(map).bindPopup('You are here');
    userLocationMarker.openPopup();
  });

  map.on('locationerror', (event) => {
    elements.locate.classList.remove('locating'); elements.locate.setAttribute('aria-label', 'Show my location');
    toast(event.code === 1 ? 'Location permission was denied.' : 'Could not determine your location.', 4000);
  });

  function startPlacement() {
    placementMode = true; elements.placementBanner.hidden = false; elements.addMarker.classList.add('active'); map.getContainer().style.cursor = 'crosshair'; map.closePopup();
  }
  function stopPlacement() { placementMode = false; elements.placementBanner.hidden = true; elements.addMarker.classList.remove('active'); map.getContainer().style.cursor = ''; }

  function openMarkerEditor(markerId = null, latlng = null) {
    const marker = markerId ? state.markers.find((item) => item.id === markerId) : null;
    editorContext = { markerId, lat: marker?.lat ?? latlng.lat, lng: marker?.lng ?? latlng.lng, type: marker?.type ?? 'Other' };
    elements.markerTitle.textContent = marker ? 'Edit marker' : 'Add marker'; elements.markerName.value = marker?.name ?? ''; elements.markerSymbol.value = marker?.symbol ?? ''; elements.markerNotes.value = marker?.notes ?? '';
    elements.markerCoordinates.value = `${editorContext.lat.toFixed(6)}, ${editorContext.lng.toFixed(6)}`; elements.markerError.textContent = '';
    elements.taskEditor.replaceChildren(); (marker?.tasks ?? []).forEach(addTaskRow); elements.linkEditor.replaceChildren(); (marker?.links ?? []).forEach(addLinkRow);
    elements.markerDialog.showModal(); setTimeout(() => elements.markerName.focus(), 30);
  }

  function addTaskRow(task = { id: uid(), title: '', details: '', completed: false }) {
    const row = document.createElement('div'); row.className = 'editor-row'; row.dataset.id = task.id;
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = task.completed; checkbox.setAttribute('aria-label', 'Task completed');
    const input = document.createElement('input'); input.type = 'text'; input.maxLength = 180; input.placeholder = 'Task title'; input.value = task.title;
    const details = document.createElement('textarea'); details.maxLength = 4000; details.rows = 3; details.placeholder = 'Task details (optional)'; details.value = task.details ?? '';
    const fields = document.createElement('div'); fields.className = 'task-fields'; fields.append(input, details);
    checkbox.addEventListener('change', () => {
      const title = input.value.trim() || 'this task';
      const action = checkbox.checked ? 'complete' : 'reactivate';
      if (!window.confirm(`Are you sure you want to ${action} “${title}”?`)) checkbox.checked = !checkbox.checked;
    });
    const remove = removeButton('Remove task', () => row.remove()); row.append(checkbox, fields, remove); elements.taskEditor.append(row); if (!task.title) input.focus();
  }
  function addLinkRow(link = { id: uid(), title: '', url: '' }) {
    const row = document.createElement('div'); row.className = 'editor-row link-row'; row.dataset.id = link.id;
    const title = document.createElement('input'); title.type = 'text'; title.maxLength = 100; title.placeholder = 'Link title'; title.value = link.title;
    const url = document.createElement('input'); url.type = 'text'; url.maxLength = 2000; url.placeholder = 'https://… or relative file'; url.value = link.url;
    row.append(title, url, removeButton('Remove link', () => row.remove())); elements.linkEditor.append(row); if (!link.title) title.focus();
  }
  function removeButton(label, handler) { const button = document.createElement('button'); button.type = 'button'; button.className = 'remove-row'; button.setAttribute('aria-label', label); button.textContent = '×'; button.addEventListener('click', handler); return button; }

  function collectEditor() {
    const name = elements.markerName.value.trim(); if (!name) throw new Error('Enter a marker name.');
    const symbol = elements.markerSymbol.value.trim(); if (!symbol || symbol.length > 12) throw new Error('Enter a pin simbol of up to 12 characters.');
    const tasks = $$('.editor-row', elements.taskEditor).map((row) => ({ id: row.dataset.id || uid(), completed: $('input[type="checkbox"]', row).checked, title: $('input[type="text"]', row).value.trim(), details: $('textarea', row).value.trim() })).filter((task) => task.title);
    const links = $$('.link-row', elements.linkEditor).map((row) => { const inputs = $$('input', row); return { id: row.dataset.id || uid(), title: inputs[0].value.trim(), url: inputs[1].value.trim() }; }).filter((link) => link.title || link.url);
    for (const link of links) { if (!link.title || !link.url) throw new Error('Each link needs both a title and a URL.'); if (!isSafeUrl(link.url)) throw new Error(`“${link.title}” uses an unsafe or invalid URL.`); }
    return { id: editorContext.markerId || uid(), name, type: editorContext.type, symbol, lat: editorContext.lat, lng: editorContext.lng, notes: elements.markerNotes.value.trim(), tasks, links };
  }

  function requestDelete(markerId) {
    const marker = state.markers.find((item) => item.id === markerId); if (!marker) return;
    elements.confirmMessage.textContent = `“${marker.name}” and its ${marker.tasks.length} task${marker.tasks.length === 1 ? '' : 's'} will be removed.`;
    elements.confirm.showModal(); elements.confirm.addEventListener('close', () => { if (elements.confirm.returnValue === 'confirm') { state.markers = state.markers.filter((item) => item.id !== markerId); persist(); toast('Marker deleted.'); } }, { once: true });
  }

  function setTaskPanel(open) { elements.taskPanel.classList.toggle('open', open); elements.taskPanel.setAttribute('aria-hidden', String(!open)); elements.tasks.setAttribute('aria-expanded', String(open)); }
  function setMobileMenu(open) { elements.mobileMenu.hidden = !open; elements.mobileMenuButton.setAttribute('aria-expanded', String(open)); }
  function openGoTo() { renderPinList(); elements.goToDialog.showModal(); }
  function applyTheme(theme) { document.documentElement.dataset.theme = theme === 'system' ? '' : theme; }
  function updateStartupLabel() { const view = state.settings.startupView; elements.startupViewLabel.textContent = `${view.center[0].toFixed(4)}, ${view.center[1].toFixed(4)} · zoom ${view.zoom}`; }

  function downloadProject() {
    const center = map.getCenter(); state.map = { center: [center.lat, center.lng], zoom: map.getZoom() };
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'project.json'; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Project saved.');
  }

  async function importProject(file) {
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('The project file is larger than 10 MB.');
      const next = normalizeProject(JSON.parse(await file.text())); state = next; applyTheme(state.settings.theme); elements.theme.value = state.settings.theme;
      map.setView(state.map.center, state.map.zoom); persist(); toast(`Opened ${state.markers.length} marker${state.markers.length === 1 ? '' : 's'}.`);
    } catch (error) { toast(`Could not open project: ${error.message}`, 5000); }
    finally { elements.file.value = ''; }
  }

  function escapeHtml(value) { const span = document.createElement('span'); span.textContent = String(value); return span.innerHTML; }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }
  function toast(message, duration = 2600) { const node = document.createElement('div'); node.className = 'toast'; node.textContent = message; elements.toastRegion.append(node); setTimeout(() => node.remove(), duration); }

  elements.addMarker.addEventListener('click', () => placementMode ? stopPlacement() : startPlacement());
  elements.locate.addEventListener('click', showMyLocation);
  elements.goTo.addEventListener('click', openGoTo);
  elements.cancelPlacement.addEventListener('click', stopPlacement);
  map.on('click', (event) => { if (!placementMode) return; stopPlacement(); openMarkerEditor(null, event.latlng); });
  map.on('moveend', () => { const center = map.getCenter(); state.map = { center: [center.lat, center.lng], zoom: map.getZoom() }; persist({ render: false }); });
  elements.tasks.addEventListener('click', () => setTaskPanel(!elements.taskPanel.classList.contains('open'))); elements.closeTasks.addEventListener('click', () => setTaskPanel(false));
  elements.mobileMenuButton.addEventListener('click', () => setMobileMenu(elements.mobileMenu.hidden));
  elements.mobileTasks.addEventListener('click', () => { setMobileMenu(false); setTaskPanel(true); });
  elements.mobileGoTo.addEventListener('click', () => { setMobileMenu(false); openGoTo(); });
  elements.mobileSave.addEventListener('click', () => { setMobileMenu(false); downloadProject(); });
  elements.mobileOpen.addEventListener('click', () => { setMobileMenu(false); elements.file.click(); });
  elements.mobileSettings.addEventListener('click', () => { setMobileMenu(false); elements.theme.value = state.settings.theme; updateStartupLabel(); elements.settingsDialog.showModal(); });
  $$('.segments button').forEach((button) => button.addEventListener('click', () => { taskFilter = button.dataset.filter; $$('.segments button').forEach((item) => item.classList.toggle('active', item === button)); renderTasks(); }));
  elements.taskSort.addEventListener('change', renderTasks); elements.search.addEventListener('input', renderSearch);
  elements.search.addEventListener('keydown', (event) => { if (event.key === 'Escape') { elements.search.value = ''; closeSearch(); } if (event.key === 'ArrowDown') { event.preventDefault(); $('.search-result', elements.searchResults)?.focus(); } });
  document.addEventListener('click', (event) => { if (!event.target.closest('.search-wrap')) closeSearch(); if (!event.target.closest('.mobile-menu') && !event.target.closest('.mobile-menu-button')) setMobileMenu(false); });
  elements.addTask.addEventListener('click', () => addTaskRow()); elements.addLink.addEventListener('click', () => addLinkRow());
  elements.markerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    try { const marker = collectEditor(); const index = state.markers.findIndex((item) => item.id === marker.id); if (index >= 0) state.markers[index] = marker; else state.markers.push(marker); elements.markerDialog.close(); persist(); toast(index >= 0 ? 'Marker updated.' : 'Marker added.'); setTimeout(() => focusMarker(marker.id), 80); }
    catch (error) { elements.markerError.textContent = error.message; }
  });
  $$('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  elements.markerDialog.addEventListener('close', () => { editorContext = null; elements.markerForm.reset(); });
  elements.save.addEventListener('click', downloadProject); elements.open.addEventListener('click', () => elements.file.click()); elements.file.addEventListener('change', () => importProject(elements.file.files[0]));
  elements.settings.addEventListener('click', () => { elements.theme.value = state.settings.theme; updateStartupLabel(); elements.settingsDialog.showModal(); });
  elements.theme.addEventListener('change', () => { state.settings.theme = elements.theme.value; applyTheme(state.settings.theme); persist({ render: false }); });
  elements.useCurrentView.addEventListener('click', () => { const center = map.getCenter(); state.settings.startupView = { center: [center.lat, center.lng], zoom: map.getZoom() }; updateStartupLabel(); persist({ render: false }); toast('Startup view updated.'); });
  elements.resetDefaultView.addEventListener('click', () => { state.settings.startupView = clone(ROMANIA_VIEW); updateStartupLabel(); persist({ render: false }); toast('Romania startup view restored.'); });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') { if (placementMode) stopPlacement(); setMobileMenu(false); } });

  renderAll();
})();
