const fs = require('node:fs');
const ts = require('typescript');
const assert = require('node:assert/strict');

module.exports = async function checkUploadDrafts(browser, baseUrl) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/api/runtime/identity`);
    const source = ts.transpileModule(fs.readFileSync('lib/translation/upload-drafts.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
    const result = await page.evaluate(async source => {
      const open = version => new Promise((resolve, reject) => { const req = indexedDB.open('mxpage-translation-uploads', version); req.onupgradeneeded = () => req.result.createObjectStore('drafts'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const file = new File(['original-bytes'], 'original.png', { type: 'image/png' });
      const draft = { input: { groups: [{ name: 'legacy', files: [file] }], languages: ['en-US'], quality: 'low', instruction: 'preserved' }, projects: [{ id: 'project', uploaded: 1 }] };
      const legacy = await open(1);
      await new Promise((resolve, reject) => { const tx = legacy.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(draft, 'legacy'); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      legacy.close();
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const { uploadDrafts } = await import(url); URL.revokeObjectURL(url);
      const restored = await uploadDrafts.get('legacy');
      const writes = [];
      const add = IDBObjectStore.prototype.add, put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.add = function(value, key) { writes.push({ store: this.name, method: 'add' }); return add.call(this, value, key); };
      IDBObjectStore.prototype.put = function(value, key) { writes.push({ store: this.name, method: 'put', containsFiles: !!value?.input || !!value?.groups }); return put.call(this, value, key); };
      await uploadDrafts.put('new', { ...draft, projects: [] });
      for (let uploaded = 1; uploaded <= 30; uploaded++) await uploadDrafts.put('new', { ...draft, projects: [{ id: 'project', uploaded }] });
      const checkpoint = await uploadDrafts.get('new');
      const db = await open(2);
      const count = name => new Promise((resolve, reject) => { const req = db.transaction(name).objectStore(name).count(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const legacyLeft = await count('drafts'); db.close();
      IDBObjectStore.prototype.put = function(value, key) { if (this.name === 'checkpoints') throw new DOMException('Simulated full disk', 'QuotaExceededError'); return put.call(this, value, key); };
      let quotaRejected = false;
      try { await uploadDrafts.put('failed', draft); } catch { quotaRejected = true; }
      IDBObjectStore.prototype.put = put; IDBObjectStore.prototype.add = add;
      const failed = await uploadDrafts.get('failed');
      await uploadDrafts.remove('new'); await uploadDrafts.remove('legacy');
      const finalDb = await open(2);
      const remaining = await Promise.all(['drafts', 'inputs', 'checkpoints'].map(name => new Promise(resolve => { const req = finalDb.transaction(name).objectStore(name).count(); req.onsuccess = () => resolve(req.result); })));
      finalDb.close();
      return { legacyText: await restored.input.groups[0].files[0].text(), legacyUploaded: restored.projects[0].uploaded, legacyLeft, writes, uploaded: checkpoint.projects[0].uploaded, newText: await checkpoint.input.groups[0].files[0].text(), quotaRejected, failedExists: !!failed, remaining };
    }, source);
    assert.equal(result.legacyText, 'original-bytes'); assert.equal(result.newText, 'original-bytes');
    assert.equal(result.legacyUploaded, 1); assert.equal(result.legacyLeft, 0);
    assert.equal(result.writes.filter(write => write.store === 'inputs' && write.method === 'add').length, 1);
    assert.equal(result.writes.filter(write => write.store === 'checkpoints').length, 31);
    assert.ok(!result.writes.some(write => write.containsFiles));
    assert.equal(result.uploaded, 30); assert.equal(result.quotaRejected, true); assert.equal(result.failedExists, false);
    assert.deepEqual(result.remaining, [0, 0, 0]);
    console.log('PASS IndexedDB v1 migration, one-time File write, 30 lightweight checkpoints, quota rollback, cleanup');
  } finally { await context.close(); }
};
