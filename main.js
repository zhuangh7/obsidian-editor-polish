'use strict';

const obsidian = require('obsidian');

const WIDTH_PRESETS = [
  { id: 'narrow', label: '窄 · 650px', value: '650px' },
  { id: 'medium', label: '中 · 800px', value: '800px' },
  { id: 'wide', label: '宽 · 1000px', value: '1000px' },
  { id: 'xwide', label: '超宽 · 1200px', value: '1200px' },
  { id: 'full', label: '全屏宽度', value: 'full' },
];

const DEFAULT_SETTINGS = {
  widthMode: 'medium',
  customWidth: '900px',
  frontmatterOverride: true,
  resizeTables: true,
  persistTableWidths: true,
  tableWidths: {},
  polishTables: true,
  polishTypography: true,
  polishScrollbar: true,
};

function normalizeLen(v) {
  v = String(v == null ? '' : v).trim();
  if (!v) return '800px';
  if (v.toLowerCase() === 'full' || v.toLowerCase() === 'none') return 'none';
  if (/^\d+(\.\d+)?$/.test(v)) return v + 'px';
  return v;
}

function resolveGlobalWidth(settings) {
  if (settings.widthMode === 'custom') return normalizeLen(settings.customWidth);
  const p = WIDTH_PRESETS.find((x) => x.id === settings.widthMode);
  if (!p) return '800px';
  return p.value === 'full' ? 'none' : p.value;
}

function widthLabel(settings) {
  if (settings.widthMode === 'custom') {
    const n = normalizeLen(settings.customWidth);
    return n === 'none' ? '全屏' : n;
  }
  const p = WIDTH_PRESETS.find((x) => x.id === settings.widthMode);
  if (!p) return '800px';
  return p.id === 'full' ? '全屏' : p.value;
}

class EditorPolishPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    this.applyBodyClasses();
    this.applyGlobalWidth();

    this.addSettingTab(new EditorPolishSettingTab(this.app, this));

    this.registerMarkdownPostProcessor((el, ctx) => {
      const tables = el.querySelectorAll('table');
      tables.forEach((t) => this.enhanceTable(t, ctx && ctx.sourcePath));
    });

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('ep-statusbar');
    this.registerDomEvent(this.statusBarEl, 'click', (e) => this.openWidthMenu(e));
    this.updateStatusBar();

    this.addCommand({ id: 'ep-cycle-width', name: '切换正文宽度（循环预设）', callback: () => this.cycleWidth(1) });
    this.addCommand({ id: 'ep-width-increase', name: '正文宽度 +60px', callback: () => this.nudgeWidth(60) });
    this.addCommand({ id: 'ep-width-decrease', name: '正文宽度 -60px', callback: () => this.nudgeWidth(-60) });
    this.addCommand({ id: 'ep-width-full', name: '正文宽度设为全屏', callback: () => this.setWidthMode('full') });
    this.addCommand({ id: 'ep-reset-current-table', name: '重置当前笔记的表格列宽', callback: () => this.resetActiveNoteTables() });
    this.addCommand({ id: 'ep-reset-all-tables', name: '清除所有已保存的表格列宽', callback: () => this.clearAllTableWidths() });

    const reapply = obsidian.debounce(() => this.applyLeafOverrides(), 120, true);
    this.registerEvent(this.app.workspace.on('active-leaf-change', reapply));
    this.registerEvent(this.app.workspace.on('layout-change', reapply));
    this.registerEvent(this.app.workspace.on('file-open', reapply));
    this.registerEvent(this.app.metadataCache.on('changed', reapply));

    const resweep = obsidian.debounce(() => this.sweepTables(), 350, true);
    this.registerEvent(this.app.workspace.on('active-leaf-change', resweep));
    this.registerEvent(this.app.workspace.on('layout-change', resweep));
    this.registerEvent(this.app.workspace.on('editor-change', resweep));

    this.app.workspace.onLayoutReady(() => {
      this.sweepTables();
      this.applyLeafOverrides();
    });
  }

  onunload() {
    document.body.classList.remove(
      'editor-polish', 'ep-resize-enabled', 'ep-polish-tables',
      'ep-polish-typography', 'ep-polish-scrollbar', 'ep-col-resizing'
    );
    document.body.style.removeProperty('--ep-line-width');
    this.teardownTables(true);
    this.clearLeafOverrides();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.tableWidths) this.settings.tableWidths = {};
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  applyBodyClasses() {
    const b = document.body;
    b.classList.add('editor-polish');
    b.classList.toggle('ep-resize-enabled', !!this.settings.resizeTables);
    b.classList.toggle('ep-polish-tables', !!this.settings.polishTables);
    b.classList.toggle('ep-polish-typography', !!this.settings.polishTypography);
    b.classList.toggle('ep-polish-scrollbar', !!this.settings.polishScrollbar);
  }

  applyGlobalWidth() {
    document.body.style.setProperty('--ep-line-width', resolveGlobalWidth(this.settings));
  }

  fileWidthOverride(file) {
    if (!this.settings.frontmatterOverride || !file) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache && cache.frontmatter;
    if (!fm) return null;
    const raw = fm['editor-width'] != null ? fm['editor-width'] : fm['ep-width'];
    if (raw == null || raw === '') return null;
    return normalizeLen(raw);
  }

  applyLeafOverrides() {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    leaves.forEach((leaf) => {
      const view = leaf.view;
      if (!view || !view.containerEl) return;
      const ov = this.fileWidthOverride(view.file);
      if (ov) view.containerEl.style.setProperty('--ep-line-width', ov);
      else view.containerEl.style.removeProperty('--ep-line-width');
    });
  }

  clearLeafOverrides() {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    leaves.forEach((leaf) => {
      if (leaf.view && leaf.view.containerEl) {
        leaf.view.containerEl.style.removeProperty('--ep-line-width');
      }
    });
  }

  updateStatusBar() {
    if (!this.statusBarEl) return;
    this.statusBarEl.setText('↔ ' + widthLabel(this.settings));
    this.statusBarEl.setAttribute('aria-label', '正文宽度（点击切换）');
  }

  openWidthMenu(evt) {
    const menu = new obsidian.Menu();
    WIDTH_PRESETS.forEach((p) => {
      menu.addItem((item) => {
        item.setTitle(p.label)
          .setChecked(this.settings.widthMode === p.id)
          .onClick(() => this.setWidthMode(p.id));
      });
    });
    menu.addSeparator();
    menu.addItem((item) => {
      item.setTitle('自定义…')
        .setChecked(this.settings.widthMode === 'custom')
        .onClick(() => this.promptCustomWidth());
    });
    menu.showAtMouseEvent(evt);
  }

  promptCustomWidth() {
    const modal = new WidthPromptModal(this.app, this.settings.customWidth, async (val) => {
      if (val == null) return;
      this.settings.customWidth = val;
      this.settings.widthMode = 'custom';
      await this.saveSettings();
      this.applyGlobalWidth();
      this.updateStatusBar();
    });
    modal.open();
  }

  async setWidthMode(mode) {
    this.settings.widthMode = mode;
    await this.saveSettings();
    this.applyGlobalWidth();
    this.updateStatusBar();
  }

  async cycleWidth(dir) {
    const ids = WIDTH_PRESETS.map((p) => p.id);
    let idx = ids.indexOf(this.settings.widthMode);
    if (idx < 0) idx = 1;
    idx = (idx + dir + ids.length) % ids.length;
    await this.setWidthMode(ids[idx]);
    new obsidian.Notice('正文宽度：' + widthLabel(this.settings));
  }

  async nudgeWidth(delta) {
    const cur = resolveGlobalWidth(this.settings);
    let px = parseFloat(cur);
    if (cur === 'none' || isNaN(px)) px = 900;
    px = Math.max(360, Math.min(2400, px + delta));
    this.settings.widthMode = 'custom';
    this.settings.customWidth = px + 'px';
    await this.saveSettings();
    this.applyGlobalWidth();
    this.updateStatusBar();
    new obsidian.Notice('正文宽度：' + px + 'px');
  }

  // ---------- 表格列宽拖拽 ----------

  tableKey(sourcePath, firstRow, cols) {
    if (!sourcePath) return null;
    const cells = Array.from(firstRow.cells).map((c) => (c.textContent || '').trim());
    return sourcePath + '§' + cols + '§' + cells.join('¦').slice(0, 240);
  }

  enhanceTable(table, sourcePath) {
    if (!this.settings.resizeTables) return;
    if (!table || table.dataset.epEnhanced === '1') return;
    const rows = table.rows;
    if (!rows || rows.length === 0) return;
    const firstRow = rows[0];
    const cols = firstRow.cells.length;
    if (cols < 2) return;
    for (let i = 0; i < firstRow.cells.length; i++) {
      if (firstRow.cells[i].colSpan > 1) return;
    }
    table.dataset.epEnhanced = '1';
    table.classList.add('ep-resizable');

    const key = this.tableKey(sourcePath, firstRow, cols);

    const inCM = !!table.closest('.cm-editor');
    if (!inCM) {
      const parent = table.parentElement;
      if (parent && !parent.classList.contains('ep-table-wrap')) {
        const wrap = document.createElement('div');
        wrap.className = 'ep-table-wrap';
        parent.insertBefore(wrap, table);
        wrap.appendChild(table);
      }
    }

    let cg = table.querySelector(':scope > colgroup');
    if (!cg) {
      cg = document.createElement('colgroup');
      for (let i = 0; i < cols; i++) cg.appendChild(document.createElement('col'));
      table.insertBefore(cg, table.firstChild);
    }
    const colEls = Array.from(cg.children);
    while (colEls.length < cols) {
      const c = document.createElement('col');
      cg.appendChild(c);
      colEls.push(c);
    }

    const stored = key && this.settings.tableWidths[key];
    if (stored && stored.length === cols) {
      table.style.tableLayout = 'fixed';
      let total = 0;
      for (let i = 0; i < cols; i++) {
        colEls[i].style.width = stored[i] + 'px';
        total += stored[i];
      }
      table.style.width = total + 'px';
    }

    for (let i = 0; i < firstRow.cells.length; i++) {
      const cell = firstRow.cells[i];
      cell.classList.add('ep-th');
      const handle = document.createElement('div');
      handle.className = 'ep-col-resize-handle';
      cell.appendChild(handle);
      const index = i;
      this.registerDomEvent(handle, 'pointerdown', (e) => this.startColResize(e, table, colEls, index, key));
      this.registerDomEvent(handle, 'dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.resetTable(table, colEls, key);
      });
      this.registerDomEvent(handle, 'click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
  }

  startColResize(evt, table, colEls, index, key) {
    evt.preventDefault();
    evt.stopPropagation();
    const cols = colEls.length;
    const firstRow = table.rows[0];

    if (table.style.tableLayout !== 'fixed') {
      const widths = [];
      for (let i = 0; i < cols; i++) {
        widths.push(Math.round(firstRow.cells[i].getBoundingClientRect().width));
      }
      let total = 0;
      for (let i = 0; i < cols; i++) {
        colEls[i].style.width = widths[i] + 'px';
        total += widths[i];
      }
      table.style.tableLayout = 'fixed';
      table.style.width = total + 'px';
    }

    const startX = evt.clientX;
    const startWidth = parseFloat(colEls[index].style.width) || firstRow.cells[index].getBoundingClientRect().width;
    const minW = 42;
    document.body.classList.add('ep-col-resizing');

    const onMove = (e) => {
      const dx = e.clientX - startX;
      const nw = Math.max(minW, Math.round(startWidth + dx));
      colEls[index].style.width = nw + 'px';
      let total = 0;
      for (let i = 0; i < cols; i++) total += parseFloat(colEls[i].style.width) || 0;
      table.style.width = total + 'px';
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.classList.remove('ep-col-resizing');
      this.persistTable(table, colEls, key);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  persistTable(table, colEls, key) {
    if (!this.settings.persistTableWidths || !key) return;
    const widths = colEls.map((c) => Math.round(parseFloat(c.style.width) || 0));
    if (widths.some((w) => !w)) return;
    this.settings.tableWidths[key] = widths;
    this.saveSettings();
  }

  resetTable(table, colEls, key) {
    table.style.tableLayout = '';
    table.style.width = '';
    colEls.forEach((c) => (c.style.width = ''));
    if (key && this.settings.tableWidths[key]) {
      delete this.settings.tableWidths[key];
      this.saveSettings();
    }
    new obsidian.Notice('已重置该表格列宽');
  }

  resetActiveNoteTables() {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view) {
      new obsidian.Notice('没有活动的 Markdown 笔记');
      return;
    }
    const tables = view.containerEl.querySelectorAll('table.ep-resizable');
    tables.forEach((t) => {
      const cg = t.querySelector(':scope > colgroup');
      const colEls = cg ? Array.from(cg.children) : [];
      const firstRow = t.rows[0];
      const key = firstRow ? this.tableKey(view.file ? view.file.path : null, firstRow, firstRow.cells.length) : null;
      this.resetTable(t, colEls, key);
    });
  }

  async clearAllTableWidths() {
    this.settings.tableWidths = {};
    await this.saveSettings();
    this.teardownTables(false);
    this.sweepTables();
    new obsidian.Notice('已清除所有保存的表格列宽');
  }

  sweepTables() {
    if (!this.settings.resizeTables) return;
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    leaves.forEach((leaf) => {
      const view = leaf.view;
      if (!view || !view.containerEl) return;
      const path = view.file ? view.file.path : null;
      view.containerEl.querySelectorAll('table').forEach((t) => this.enhanceTable(t, path));
    });
  }

  teardownTables(removeWrap) {
    document.querySelectorAll('table.ep-resizable').forEach((t) => {
      delete t.dataset.epEnhanced;
      t.classList.remove('ep-resizable');
      t.style.tableLayout = '';
      t.style.width = '';
      const cg = t.querySelector(':scope > colgroup');
      if (cg) cg.querySelectorAll('col').forEach((c) => (c.style.width = ''));
      t.querySelectorAll('.ep-col-resize-handle').forEach((h) => h.remove());
      t.querySelectorAll('.ep-th').forEach((c) => c.classList.remove('ep-th'));
      if (removeWrap) {
        const wrap = t.parentElement;
        if (wrap && wrap.classList.contains('ep-table-wrap') && wrap.parentElement) {
          wrap.parentElement.insertBefore(t, wrap);
          wrap.remove();
        }
      }
    });
  }

  refreshTablesEnabled() {
    this.applyBodyClasses();
    if (this.settings.resizeTables) this.sweepTables();
    else this.teardownTables(true);
  }
}

class WidthPromptModal extends obsidian.Modal {
  constructor(app, initial, onSubmit) {
    super(app);
    this.value = initial || '';
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '自定义正文宽度' });
    contentEl.createEl('p', {
      text: '输入数字(按 px 处理)或任意 CSS 宽度，例如 760、860px、60rem、80ch；输入 full 为全屏。',
      cls: 'ep-modal-hint',
    });
    const input = contentEl.createEl('input', { type: 'text' });
    input.value = this.value;
    input.addClass('ep-width-input');
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    const submit = () => {
      const v = input.value;
      this.close();
      this.onSubmit(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const btnRow = contentEl.createDiv('ep-modal-btns');
    const ok = btnRow.createEl('button', { text: '应用' });
    ok.addClass('mod-cta');
    ok.addEventListener('click', submit);
    const cancel = btnRow.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
  }
  onClose() {
    this.contentEl.empty();
  }
}

class EditorPolishSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();

    new obsidian.Setting(containerEl).setName('正文宽度').setHeading();

    new obsidian.Setting(containerEl)
      .setName('宽度预设')
      .setDesc('设置正文(编辑与阅读)内容区域的宽度。')
      .addDropdown((dd) => {
        WIDTH_PRESETS.forEach((p) => dd.addOption(p.id, p.label));
        dd.addOption('custom', '自定义');
        dd.setValue(this.plugin.settings.widthMode);
        dd.onChange(async (v) => {
          this.plugin.settings.widthMode = v;
          await this.plugin.saveSettings();
          this.plugin.applyGlobalWidth();
          this.plugin.updateStatusBar();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('自定义宽度')
      .setDesc('数字按 px 处理；也可用 rem / ch / %，或 full 表示全屏。仅在“自定义”预设时生效。')
      .addText((t) => {
        t.setPlaceholder('900px')
          .setValue(this.plugin.settings.customWidth)
          .onChange(async (v) => {
            this.plugin.settings.customWidth = v;
            await this.plugin.saveSettings();
            if (this.plugin.settings.widthMode === 'custom') {
              this.plugin.applyGlobalWidth();
              this.plugin.updateStatusBar();
            }
          });
      });

    new obsidian.Setting(containerEl)
      .setName('按笔记覆盖宽度 (frontmatter)')
      .setDesc('在笔记属性里写 editor-width: 1000 可单独设置该笔记宽度；写 full 为全屏。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.frontmatterOverride).onChange(async (v) => {
          this.plugin.settings.frontmatterOverride = v;
          await this.plugin.saveSettings();
          this.plugin.clearLeafOverrides();
          this.plugin.applyLeafOverrides();
        })
      );

    new obsidian.Setting(containerEl).setName('表格').setHeading();

    new obsidian.Setting(containerEl)
      .setName('拖拽调整列宽')
      .setDesc('把鼠标移到表头单元格右边缘拖动即可调整列宽；双击边缘重置整张表。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.resizeTables).onChange(async (v) => {
          this.plugin.settings.resizeTables = v;
          await this.plugin.saveSettings();
          this.plugin.refreshTablesEnabled();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('记住列宽')
      .setDesc('按“笔记 + 表头”记忆已调整的列宽 (Markdown 本身不存列宽，为尽力保存)。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.persistTableWidths).onChange(async (v) => {
          this.plugin.settings.persistTableWidths = v;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('表格外观美化')
      .setDesc('更清晰的边框、表头底色、斑马纹、悬停高亮与圆角。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.polishTables).onChange(async (v) => {
          this.plugin.settings.polishTables = v;
          await this.plugin.saveSettings();
          this.plugin.applyBodyClasses();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('清除所有已保存的列宽')
      .addButton((b) =>
        b.setButtonText('清除').setWarning().onClick(() => this.plugin.clearAllTableWidths())
      );

    new obsidian.Setting(containerEl).setName('通用美化').setHeading();

    new obsidian.Setting(containerEl)
      .setName('排版美化')
      .setDesc('优化行距、标题间距、引用块、行内代码与分割线。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.polishTypography).onChange(async (v) => {
          this.plugin.settings.polishTypography = v;
          await this.plugin.saveSettings();
          this.plugin.applyBodyClasses();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('滚动条美化')
      .setDesc('更纤细、圆润的滚动条。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.polishScrollbar).onChange(async (v) => {
          this.plugin.settings.polishScrollbar = v;
          await this.plugin.saveSettings();
          this.plugin.applyBodyClasses();
        })
      );
  }
}

module.exports = EditorPolishPlugin;
