const fs = require("fs");
const path = require("path");

const DATE_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

function dateFilePath(rootDir, date) {
  const match = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`invalid archive date: ${date}`);
  return path.join(rootDir, match[1], match[2], `${date}.jsonl`);
}

function ensureDateFile(rootDir, date) {
  const file = dateFilePath(rootDir, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacy = path.join(rootDir, `${date}.jsonl`);
  if (!fs.existsSync(file) && fs.existsSync(legacy)) fs.renameSync(legacy, file);
  return file;
}

function resolveDateFile(rootDir, date) {
  const nested = dateFilePath(rootDir, date);
  if (fs.existsSync(nested)) return nested;
  const legacy = path.join(rootDir, `${date}.jsonl`);
  return fs.existsSync(legacy) ? legacy : nested;
}

function listDateFiles(rootDir) {
  const byDate = new Map();
  try {
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        const match = entry.name.match(DATE_FILE_RE);
        if (match) byDate.set(entry.name.slice(0, 10), path.join(rootDir, entry.name));
      }
    }
    for (const year of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const yearDir = path.join(rootDir, year.name);
      for (const month of fs.readdirSync(yearDir, { withFileTypes: true })) {
        if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
        const monthDir = path.join(yearDir, month.name);
        for (const file of fs.readdirSync(monthDir, { withFileTypes: true })) {
          if (!file.isFile()) continue;
          const match = file.name.match(DATE_FILE_RE);
          if (match && match[1] === year.name && match[2] === month.name) {
            byDate.set(file.name.slice(0, 10), path.join(monthDir, file.name));
          }
        }
      }
    }
  } catch {}
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, file]) => ({ date, file }));
}

function listDates(rootDir) {
  return listDateFiles(rootDir).map(item => item.date);
}

function listJsonlRecursive(rootDir) {
  const files = [];
  function visit(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  }
  visit(rootDir);
  return files.sort();
}

function migrateFlatFiles(rootDir) {
  let moved = 0;
  try {
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isFile() || !DATE_FILE_RE.test(entry.name)) continue;
      const date = entry.name.slice(0, 10);
      const target = dateFilePath(rootDir, date);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) continue;
      fs.renameSync(path.join(rootDir, entry.name), target);
      moved++;
    }
  } catch {}
  return moved;
}

module.exports = { dateFilePath, ensureDateFile, resolveDateFile, listDateFiles, listDates, listJsonlRecursive, migrateFlatFiles };
