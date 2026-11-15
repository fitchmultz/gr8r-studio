import { buildAttachmentBlobUrl } from '../src/core/domain.js';

export function normalizeBlobRef(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const norm = String(raw).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(norm) ? norm : 'invalid';
}

export function blobRefCounts(data) {
  const counts = new Map();
  if (!data || typeof data !== 'object') return counts;
  const seenFileIds = new Set();
  const files = Array.isArray(data.files) ? data.files : [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const bid = normalizeBlobRef(f.blobId);
    if (bid && bid !== 'invalid') {
      if (f.id) seenFileIds.add(f.id);
      counts.set(bid, (counts.get(bid) || 0) + 1);
    }
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  for (const t of tasks) {
    const atts = Array.isArray(t?.attachments) ? t.attachments : [];
    for (const a of atts) {
      if (!a || typeof a !== 'object') continue;
      if (a.id && seenFileIds.has(a.id)) continue;
      const bid = normalizeBlobRef(a.blobId);
      if (bid && bid !== 'invalid') {
        counts.set(bid, (counts.get(bid) || 0) + 1);
      }
    }
  }
  return counts;
}

/* Normalize valid blobIds to lowercase hex and strip newly introduced attachment
   references whose blob bytes are missing on disk (keeping any inline dataUrl fallback)
   so batch syncs preserve all unrelated edits without committing dangling 404 refs. */
export function sanitizeStateBlobs(data, prevCounts, hasBlob) {
  let changed = false;
  const droppedFiles = [];
  const droppedKeys = new Set();
  if (!data || typeof data !== 'object') return { changed, droppedFiles };

  const noteDropped = rec => {
    const key = rec.id || `${rec.name || ''}:${rec.blobId || ''}`;
    if (!droppedKeys.has(key)) {
      droppedKeys.add(key);
      droppedFiles.push(rec.name || rec.id || 'attachment');
    }
  };

  const sanitizeList = list => {
    const kept = [];
    for (const rec of list) {
      if (!rec || typeof rec !== 'object') {
        kept.push(rec);
        continue;
      }
      const bid = normalizeBlobRef(rec.blobId);
      if (bid === null) {
        kept.push(rec);
        continue;
      }
      if (bid !== 'invalid' && (prevCounts.has(bid) || !hasBlob || hasBlob(bid))) {
        if (rec.blobId !== bid) {
          rec.blobId = bid;
          changed = true;
        }
        if (typeof rec.url === 'string' && rec.url.startsWith('/api/blobs/')) {
          const nextUrl = buildAttachmentBlobUrl(rec);
          if (rec.url !== nextUrl) {
            rec.url = nextUrl;
            changed = true;
          }
        }
        kept.push(rec);
        continue;
      }
      changed = true;
      noteDropped(rec);
      if (typeof rec.dataUrl === 'string' && rec.dataUrl) {
        delete rec.blobId;
        if (typeof rec.url === 'string' && rec.url.startsWith('/api/blobs/')) delete rec.url;
        kept.push(rec);
      }
    }
    return kept;
  };

  if (Array.isArray(data.files)) {
    const nextFiles = sanitizeList(data.files);
    if (nextFiles.length !== data.files.length) data.files = nextFiles;
  }
  if (Array.isArray(data.tasks)) {
    for (const t of data.tasks) {
      if (t && Array.isArray(t.attachments)) {
        const nextAtts = sanitizeList(t.attachments);
        if (nextAtts.length !== t.attachments.length) t.attachments = nextAtts;
      }
    }
  }
  return { changed, droppedFiles };
}
