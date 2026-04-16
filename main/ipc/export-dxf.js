const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { normalizeSettings } = require('../../shared/settings');

function registerExportDxfIpc() {
  // Write one DXF per strip using placement data from the strip JSON files.
  ipcMain.handle('export-sheets-dxf', async (event, { outputDir, jobName, inputPath, exportItems = {}, strips }) => {
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      const safeName = String(jobName || 'sheet')
        .replace(/[^a-z0-9-_]+/gi, '-')
        .replace(/^-+|-+$/g, '') || 'sheet';

      const globalItemsById = {};
      const exportSettings = {};
      if (inputPath && fs.existsSync(inputPath)) {
        try {
          const inputData = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
          Object.assign(exportSettings, normalizeSettings(inputData.settings || {}));
          (inputData.items || []).forEach(item => { globalItemsById[item.id] = item; });
        } catch (e) {
          // Fall through — will export what it can.
        }
      }

      const RAD = Math.PI / 180;

      function applyTransform(pts, rotation, tx, ty) {
        const cos = Math.cos(rotation * RAD);
        const sin = Math.sin(rotation * RAD);
        return pts.map(([x, y]) => [
          +(cos * x - sin * y + tx).toFixed(4),
          +(sin * x + cos * y + ty).toFixed(4),
        ]);
      }

      function transformPoint(pt, rotation, tx, ty) {
        const cos = Math.cos(rotation * RAD);
        const sin = Math.sin(rotation * RAD);
        const x = Number(pt?.x || 0);
        const y = Number(pt?.y || 0);
        return {
          x: +(cos * x - sin * y + tx).toFixed(4),
          y: +(sin * x + cos * y + ty).toFixed(4),
          z: Number.isFinite(pt?.z) ? +pt.z.toFixed(4) : 0,
        };
      }

      function rotateVector(pt, rotation) {
        const cos = Math.cos(rotation * RAD);
        const sin = Math.sin(rotation * RAD);
        const x = Number(pt?.x || 0);
        const y = Number(pt?.y || 0);
        return {
          x: +(cos * x - sin * y).toFixed(4),
          y: +(sin * x + cos * y).toFixed(4),
          z: Number.isFinite(pt?.z) ? +pt.z.toFixed(4) : 0,
        };
      }

      function approxAciFromHex(hex) {
        const mapping = {
          '#FF4444': 1,
          '#FFFF44': 2,
          '#44DD44': 3,
          '#44DDDD': 4,
          '#4488FF': 5,
          '#DD44DD': 6,
          '#CCCCCC': 7,
          '#888888': 8,
        };
        return mapping[String(hex || '').toUpperCase()] || 7;
      }

      function entityColorCodes(entity) {
        if (!entity) return null;
        const aci = [entity.colorNumber, entity.colorIndex, entity.aci]
          .find(value => Number.isFinite(value));
        if (Number.isFinite(aci) && aci !== 256 && aci !== 0) {
          return { type: 'aci', value: Math.abs(Math.trunc(aci)) };
        }
        if (typeof entity.color === 'string') {
          return { type: 'aci', value: approxAciFromHex(entity.color) };
        }
        return null;
      }

      function writeColor(lines, entity) {
        const color = entityColorCodes(entity);
        if (!color) return;
        if (color.type === 'aci') {
          lines.push('62', String(color.value));
        }
      }

      function collectLayerDefs(sheetStrips) {
        const layerMap = new Map();
        const addLayer = (name, color) => {
          const layerName = String(name || '0');
          const nextColor = color || '#CCCCCC';
          const existing = layerMap.get(layerName);
          if (!existing) {
            layerMap.set(layerName, { name: layerName, color: nextColor });
            return;
          }
          if (color && existing.color !== color) {
            layerMap.set(layerName, { name: layerName, color });
          }
        };

        addLayer('0', '#CCCCCC');

        sheetStrips.forEach(strip => {
          strip.placedItems.forEach(placement => {
            const exportItem = exportItems?.[placement.item_id];
            (exportItem?.layers || []).forEach(layer => addLayer(layer.name, layer.color));
            const item = { ...globalItemsById[placement.item_id], export: exportItem };
            const engravingLayer = getEngravingLayer(item);
            if (engravingLayer) addLayer(engravingLayer.name, engravingLayer.color);
          });
        });

        return [...layerMap.values()];
      }

      function getEngravingLayer(item) {
        const raw = exportSettings.engravingLayer;
        if (raw === 'off' || raw == null || raw === '' || raw === false) return null;
        const idx = Number.parseInt(String(raw), 10);
        if (!Number.isFinite(idx) || idx < 1) return null;
        return item?.export?.layers?.[idx - 1] || null;
      }

      function labelForItem(item) {
        const sourceName = item?.export?.source_name || item?.dxf || '';
        return path.basename(String(sourceName)).replace(/\.dxf$/i, '');
      }

      function bboxFromPolygon(points) {
        if (!Array.isArray(points) || !points.length) return null;
        const xs = points.map(([x]) => x);
        const ys = points.map(([, y]) => y);
        return {
          minX: Math.min(...xs),
          maxX: Math.max(...xs),
          minY: Math.min(...ys),
          maxY: Math.max(...ys),
        };
      }

      const OUTLINE_FONT = {
        '0': [
          [[0.22,0.08],[0.78,0.08],[0.92,0.22],[0.92,0.78],[0.78,0.92],[0.22,0.92],[0.08,0.78],[0.08,0.22]],
          [[0.34,0.26],[0.66,0.26],[0.74,0.34],[0.74,0.66],[0.66,0.74],[0.34,0.74],[0.26,0.66],[0.26,0.34]],
        ],
        '1': [
          [[0.42,0.1],[0.62,0.1],[0.62,0.9],[0.42,0.9]],
          [[0.26,0.26],[0.42,0.1],[0.42,0.28],[0.32,0.38],[0.26,0.38]],
        ],
        '2': [
          [[0.14,0.22],[0.24,0.1],[0.76,0.1],[0.88,0.22],[0.88,0.38],[0.22,0.72],[0.22,0.78],[0.9,0.78],[0.9,0.92],[0.1,0.92],[0.1,0.7],[0.76,0.36],[0.76,0.24],[0.68,0.22],[0.24,0.22]],
        ],
        '3': [
          [[0.12,0.2],[0.24,0.1],[0.74,0.1],[0.88,0.22],[0.88,0.4],[0.74,0.5],[0.88,0.6],[0.88,0.78],[0.74,0.9],[0.24,0.9],[0.12,0.8],[0.28,0.7],[0.68,0.7],[0.74,0.64],[0.74,0.56],[0.66,0.5],[0.36,0.5],[0.36,0.36],[0.66,0.36],[0.74,0.3],[0.74,0.22],[0.68,0.2],[0.28,0.2]],
        ],
        '4': [
          [[0.58,0.1],[0.78,0.1],[0.78,0.9],[0.58,0.9]],
          [[0.14,0.46],[0.62,0.46],[0.62,0.62],[0.14,0.62]],
          [[0.14,0.46],[0.52,0.1],[0.7,0.1],[0.32,0.46]],
        ],
        '5': [
          [[0.14,0.1],[0.88,0.1],[0.88,0.24],[0.3,0.24],[0.3,0.42],[0.74,0.42],[0.88,0.56],[0.88,0.78],[0.74,0.92],[0.24,0.92],[0.12,0.82],[0.26,0.7],[0.68,0.7],[0.74,0.64],[0.74,0.58],[0.68,0.54],[0.14,0.54]],
        ],
        '6': [
          [[0.8,0.18],[0.68,0.08],[0.28,0.08],[0.12,0.22],[0.12,0.78],[0.26,0.92],[0.74,0.92],[0.88,0.78],[0.88,0.58],[0.74,0.44],[0.3,0.44],[0.3,0.28],[0.36,0.22],[0.68,0.22],[0.8,0.32],[0.88,0.2]],
          [[0.3,0.58],[0.7,0.58],[0.74,0.62],[0.74,0.72],[0.68,0.78],[0.32,0.78],[0.26,0.72],[0.26,0.62]],
        ],
        '7': [
          [[0.1,0.1],[0.9,0.1],[0.9,0.24],[0.48,0.92],[0.26,0.92],[0.66,0.24],[0.1,0.24]],
        ],
        '8': [
          [[0.24,0.08],[0.76,0.08],[0.88,0.2],[0.88,0.36],[0.76,0.48],[0.88,0.6],[0.88,0.8],[0.76,0.92],[0.24,0.92],[0.12,0.8],[0.12,0.6],[0.24,0.48],[0.12,0.36],[0.12,0.2]],
          [[0.3,0.22],[0.68,0.22],[0.74,0.28],[0.74,0.34],[0.68,0.4],[0.3,0.4],[0.26,0.34],[0.26,0.28]],
          [[0.3,0.56],[0.68,0.56],[0.74,0.62],[0.74,0.72],[0.68,0.78],[0.3,0.78],[0.26,0.72],[0.26,0.62]],
        ],
        '9': [
          [[0.24,0.08],[0.74,0.08],[0.88,0.22],[0.88,0.78],[0.72,0.92],[0.34,0.92],[0.2,0.82],[0.3,0.7],[0.68,0.7],[0.74,0.64],[0.74,0.52],[0.68,0.46],[0.24,0.46],[0.1,0.32],[0.1,0.22]],
          [[0.3,0.22],[0.66,0.22],[0.74,0.3],[0.74,0.38],[0.68,0.46],[0.32,0.46],[0.26,0.4],[0.26,0.28]],
        ],
        'A': [
          [[0.08,0.92],[0.38,0.08],[0.62,0.08],[0.92,0.92],[0.72,0.92],[0.64,0.68],[0.36,0.68],[0.28,0.92]],
          [[0.42,0.5],[0.58,0.5],[0.5,0.26]],
        ],
        'B': [
          [[0.12,0.08],[0.64,0.08],[0.82,0.2],[0.82,0.38],[0.68,0.5],[0.82,0.62],[0.82,0.8],[0.64,0.92],[0.12,0.92]],
          [[0.28,0.24],[0.58,0.24],[0.66,0.3],[0.66,0.4],[0.58,0.46],[0.28,0.46]],
          [[0.28,0.56],[0.58,0.56],[0.66,0.62],[0.66,0.74],[0.58,0.78],[0.28,0.78]],
        ],
        'C': [
          [[0.88,0.2],[0.74,0.08],[0.24,0.08],[0.08,0.24],[0.08,0.76],[0.24,0.92],[0.74,0.92],[0.88,0.8],[0.74,0.68],[0.64,0.76],[0.32,0.76],[0.24,0.68],[0.24,0.32],[0.32,0.24],[0.64,0.24],[0.74,0.32]],
        ],
        'D': [
          [[0.12,0.08],[0.56,0.08],[0.82,0.24],[0.82,0.76],[0.56,0.92],[0.12,0.92]],
          [[0.28,0.24],[0.5,0.24],[0.66,0.34],[0.66,0.66],[0.5,0.76],[0.28,0.76]],
        ],
        'E': [
          [[0.12,0.08],[0.88,0.08],[0.88,0.24],[0.28,0.24],[0.28,0.42],[0.72,0.42],[0.72,0.58],[0.28,0.58],[0.28,0.76],[0.88,0.76],[0.88,0.92],[0.12,0.92]],
        ],
        'F': [
          [[0.12,0.08],[0.88,0.08],[0.88,0.24],[0.28,0.24],[0.28,0.42],[0.72,0.42],[0.72,0.58],[0.28,0.58],[0.28,0.92],[0.12,0.92]],
        ],
        'G': [
          [[0.88,0.2],[0.74,0.08],[0.24,0.08],[0.08,0.24],[0.08,0.76],[0.24,0.92],[0.74,0.92],[0.88,0.78],[0.88,0.56],[0.56,0.56],[0.56,0.7],[0.72,0.7],[0.72,0.68],[0.64,0.76],[0.32,0.76],[0.24,0.68],[0.24,0.32],[0.32,0.24],[0.64,0.24],[0.74,0.32]],
        ],
        'H': [
          [[0.12,0.08],[0.28,0.08],[0.28,0.42],[0.72,0.42],[0.72,0.08],[0.88,0.08],[0.88,0.92],[0.72,0.92],[0.72,0.58],[0.28,0.58],[0.28,0.92],[0.12,0.92]],
        ],
        'I': [
          [[0.16,0.08],[0.84,0.08],[0.84,0.22],[0.58,0.22],[0.58,0.78],[0.84,0.78],[0.84,0.92],[0.16,0.92],[0.16,0.78],[0.42,0.78],[0.42,0.22],[0.16,0.22]],
        ],
        'J': [
          [[0.18,0.72],[0.34,0.72],[0.34,0.76],[0.42,0.84],[0.64,0.84],[0.72,0.76],[0.72,0.08],[0.88,0.08],[0.88,0.8],[0.7,0.92],[0.36,0.92],[0.18,0.8]],
        ],
        'K': [
          [[0.12,0.08],[0.28,0.08],[0.28,0.42],[0.72,0.08],[0.92,0.08],[0.5,0.42],[0.94,0.92],[0.74,0.92],[0.28,0.48],[0.28,0.92],[0.12,0.92]],
        ],
        'L': [
          [[0.12,0.08],[0.28,0.08],[0.28,0.76],[0.88,0.76],[0.88,0.92],[0.12,0.92]],
        ],
        'M': [
          [[0.08,0.92],[0.08,0.08],[0.28,0.08],[0.5,0.46],[0.72,0.08],[0.92,0.08],[0.92,0.92],[0.76,0.92],[0.76,0.34],[0.58,0.64],[0.42,0.64],[0.24,0.34],[0.24,0.92]],
        ],
        'N': [
          [[0.12,0.92],[0.12,0.08],[0.3,0.08],[0.72,0.66],[0.72,0.08],[0.88,0.08],[0.88,0.92],[0.72,0.92],[0.28,0.32],[0.28,0.92]],
        ],
        'O': [
          [[0.24,0.08],[0.76,0.08],[0.92,0.24],[0.92,0.76],[0.76,0.92],[0.24,0.92],[0.08,0.76],[0.08,0.24]],
          [[0.34,0.24],[0.66,0.24],[0.76,0.34],[0.76,0.66],[0.66,0.76],[0.34,0.76],[0.24,0.66],[0.24,0.34]],
        ],
        'P': [
          [[0.12,0.92],[0.12,0.08],[0.66,0.08],[0.84,0.22],[0.84,0.42],[0.66,0.56],[0.28,0.56],[0.28,0.92]],
        ],
        'Q': [
          [[0.24,0.08],[0.76,0.08],[0.92,0.24],[0.92,0.76],[0.76,0.92],[0.24,0.92],[0.08,0.76],[0.08,0.24]],
          [[0.34,0.24],[0.66,0.24],[0.76,0.34],[0.76,0.66],[0.66,0.76],[0.34,0.76],[0.24,0.66],[0.24,0.34]],
          [[0.58,0.64],[0.92,0.98],[0.78,1.0],[0.48,0.7]],
        ],
        'R': [
          [[0.12,0.92],[0.12,0.08],[0.64,0.08],[0.84,0.22],[0.84,0.4],[0.68,0.52],[0.48,0.52],[0.88,0.92],[0.66,0.92],[0.28,0.56],[0.28,0.92]],
        ],
        'S': [
          [[0.86,0.18],[0.72,0.08],[0.24,0.08],[0.1,0.2],[0.1,0.36],[0.24,0.48],[0.72,0.48],[0.78,0.54],[0.78,0.68],[0.7,0.76],[0.24,0.76],[0.12,0.86],[0.24,0.92],[0.76,0.92],[0.9,0.8],[0.9,0.62],[0.76,0.5],[0.28,0.5],[0.22,0.44],[0.22,0.28],[0.3,0.24],[0.74,0.24]],
        ],
        'T': [
          [[0.1,0.08],[0.9,0.08],[0.9,0.24],[0.58,0.24],[0.58,0.92],[0.42,0.92],[0.42,0.24],[0.1,0.24]],
        ],
        'U': [
          [[0.12,0.08],[0.28,0.08],[0.28,0.68],[0.34,0.76],[0.66,0.76],[0.72,0.68],[0.72,0.08],[0.88,0.08],[0.88,0.72],[0.72,0.92],[0.28,0.92],[0.12,0.72]],
        ],
        'V': [
          [[0.08,0.08],[0.28,0.08],[0.5,0.72],[0.72,0.08],[0.92,0.08],[0.6,0.92],[0.4,0.92]],
        ],
        'W': [
          [[0.08,0.08],[0.24,0.08],[0.34,0.66],[0.48,0.24],[0.62,0.66],[0.76,0.08],[0.92,0.08],[0.72,0.92],[0.56,0.92],[0.48,0.56],[0.4,0.92],[0.24,0.92]],
        ],
        'X': [
          [[0.1,0.08],[0.32,0.08],[0.5,0.36],[0.68,0.08],[0.9,0.08],[0.62,0.48],[0.92,0.92],[0.7,0.92],[0.5,0.62],[0.3,0.92],[0.08,0.92],[0.38,0.48]],
        ],
        'Y': [
          [[0.08,0.08],[0.28,0.08],[0.5,0.38],[0.72,0.08],[0.92,0.08],[0.58,0.54],[0.58,0.92],[0.42,0.92],[0.42,0.54]],
        ],
        'Z': [
          [[0.1,0.08],[0.9,0.08],[0.9,0.22],[0.34,0.78],[0.9,0.78],[0.9,0.92],[0.1,0.92],[0.1,0.78],[0.66,0.22],[0.1,0.22]],
        ],
        '-': [
          [[0.2,0.42],[0.8,0.42],[0.8,0.58],[0.2,0.58]],
        ],
        '_': [
          [[0.1,0.84],[0.9,0.84],[0.9,0.94],[0.1,0.94]],
        ],
        ' ': [],
      };

      const STROKE_FONT = {
        '0': [[[0.1,0.1],[0.9,0.1]], [[0.9,0.1],[0.9,0.9]], [[0.9,0.9],[0.1,0.9]], [[0.1,0.9],[0.1,0.1]]],
        '1': [[[0.5,0.1],[0.5,0.9]], [[0.35,0.25],[0.5,0.1]], [[0.35,0.9],[0.65,0.9]]],
        '2': [[[0.1,0.2],[0.3,0.1]], [[0.3,0.1],[0.7,0.1]], [[0.7,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.45]], [[0.9,0.45],[0.1,0.9]], [[0.1,0.9],[0.9,0.9]]],
        '3': [[[0.1,0.1],[0.9,0.1]], [[0.9,0.1],[0.6,0.5]], [[0.6,0.5],[0.9,0.9]], [[0.1,0.9],[0.9,0.9]], [[0.3,0.5],[0.7,0.5]]],
        '4': [[[0.8,0.1],[0.8,0.9]], [[0.1,0.55],[0.9,0.55]], [[0.1,0.55],[0.65,0.1]]],
        '5': [[[0.9,0.1],[0.1,0.1]], [[0.1,0.1],[0.1,0.5]], [[0.1,0.5],[0.7,0.5]], [[0.7,0.5],[0.9,0.65]], [[0.9,0.65],[0.9,0.9]], [[0.9,0.9],[0.1,0.9]]],
        '6': [[[0.8,0.1],[0.2,0.1]], [[0.2,0.1],[0.1,0.5]], [[0.1,0.5],[0.1,0.8]], [[0.1,0.8],[0.25,0.9]], [[0.25,0.9],[0.8,0.9]], [[0.8,0.9],[0.9,0.75]], [[0.9,0.75],[0.9,0.6]], [[0.9,0.6],[0.8,0.5]], [[0.8,0.5],[0.1,0.5]]],
        '7': [[[0.1,0.1],[0.9,0.1]], [[0.9,0.1],[0.35,0.9]]],
        '8': [[[0.2,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.4]], [[0.9,0.4],[0.8,0.5]], [[0.8,0.5],[0.9,0.6]], [[0.9,0.6],[0.9,0.8]], [[0.9,0.8],[0.8,0.9]], [[0.8,0.9],[0.2,0.9]], [[0.2,0.9],[0.1,0.8]], [[0.1,0.8],[0.1,0.6]], [[0.1,0.6],[0.2,0.5]], [[0.2,0.5],[0.1,0.4]], [[0.1,0.4],[0.1,0.25]], [[0.1,0.25],[0.2,0.1]], [[0.2,0.5],[0.8,0.5]]],
        '9': [[[0.9,0.5],[0.2,0.5]], [[0.2,0.5],[0.1,0.4]], [[0.1,0.4],[0.1,0.2]], [[0.1,0.2],[0.2,0.1]], [[0.2,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.2]], [[0.9,0.2],[0.9,0.9]], [[0.9,0.9],[0.2,0.9]]],
        'A': [[[0.1,0.9],[0.5,0.1]], [[0.5,0.1],[0.9,0.9]], [[0.25,0.6],[0.75,0.6]]],
        'B': [[[0.1,0.1],[0.1,0.9]], [[0.1,0.1],[0.75,0.1]], [[0.75,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.4]], [[0.9,0.4],[0.75,0.5]], [[0.75,0.5],[0.1,0.5]], [[0.75,0.5],[0.9,0.6]], [[0.9,0.6],[0.9,0.8]], [[0.9,0.8],[0.75,0.9]], [[0.75,0.9],[0.1,0.9]]],
        'C': [[[0.9,0.2],[0.75,0.1]], [[0.75,0.1],[0.2,0.1]], [[0.2,0.1],[0.1,0.25]], [[0.1,0.25],[0.1,0.75]], [[0.1,0.75],[0.2,0.9]], [[0.2,0.9],[0.75,0.9]], [[0.75,0.9],[0.9,0.8]]],
        'D': [[[0.1,0.1],[0.1,0.9]], [[0.1,0.1],[0.7,0.1]], [[0.7,0.1],[0.9,0.3]], [[0.9,0.3],[0.9,0.7]], [[0.9,0.7],[0.7,0.9]], [[0.7,0.9],[0.1,0.9]]],
        'E': [[[0.9,0.1],[0.1,0.1]], [[0.1,0.1],[0.1,0.9]], [[0.1,0.5],[0.7,0.5]], [[0.1,0.9],[0.9,0.9]]],
        'F': [[[0.1,0.1],[0.1,0.9]], [[0.1,0.1],[0.9,0.1]], [[0.1,0.5],[0.7,0.5]]],
        'G': [[[0.9,0.25],[0.75,0.1]], [[0.75,0.1],[0.2,0.1]], [[0.2,0.1],[0.1,0.25]], [[0.1,0.25],[0.1,0.75]], [[0.1,0.75],[0.2,0.9]], [[0.2,0.9],[0.75,0.9]], [[0.75,0.9],[0.9,0.75]], [[0.9,0.75],[0.9,0.55]], [[0.9,0.55],[0.55,0.55]]],
        'H': [[[0.1,0.1],[0.1,0.9]], [[0.9,0.1],[0.9,0.9]], [[0.1,0.5],[0.9,0.5]]],
        'I': [[[0.2,0.1],[0.8,0.1]], [[0.5,0.1],[0.5,0.9]], [[0.2,0.9],[0.8,0.9]]],
        'J': [[[0.8,0.1],[0.8,0.8]], [[0.8,0.8],[0.65,0.9]], [[0.65,0.9],[0.3,0.9]], [[0.3,0.9],[0.15,0.75]]],
        'K': [[[0.1,0.1],[0.1,0.9]], [[0.9,0.1],[0.1,0.55]], [[0.35,0.45],[0.9,0.9]]],
        'L': [[[0.1,0.1],[0.1,0.9]], [[0.1,0.9],[0.9,0.9]]],
        'M': [[[0.1,0.9],[0.1,0.1]], [[0.1,0.1],[0.5,0.5]], [[0.5,0.5],[0.9,0.1]], [[0.9,0.1],[0.9,0.9]]],
        'N': [[[0.1,0.9],[0.1,0.1]], [[0.1,0.1],[0.9,0.9]], [[0.9,0.9],[0.9,0.1]]],
        'O': [[[0.2,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.75]], [[0.9,0.75],[0.8,0.9]], [[0.8,0.9],[0.2,0.9]], [[0.2,0.9],[0.1,0.75]], [[0.1,0.75],[0.1,0.25]], [[0.1,0.25],[0.2,0.1]]],
        'P': [[[0.1,0.9],[0.1,0.1]], [[0.1,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.4]], [[0.9,0.4],[0.8,0.5]], [[0.8,0.5],[0.1,0.5]]],
        'Q': [[[0.2,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.75]], [[0.9,0.75],[0.8,0.9]], [[0.8,0.9],[0.2,0.9]], [[0.2,0.9],[0.1,0.75]], [[0.1,0.75],[0.1,0.25]], [[0.1,0.25],[0.2,0.1]], [[0.55,0.65],[0.9,1.0]]],
        'R': [[[0.1,0.9],[0.1,0.1]], [[0.1,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.4]], [[0.9,0.4],[0.8,0.5]], [[0.8,0.5],[0.1,0.5]], [[0.45,0.5],[0.9,0.9]]],
        'S': [[[0.9,0.15],[0.75,0.1]], [[0.75,0.1],[0.2,0.1]], [[0.2,0.1],[0.1,0.25]], [[0.1,0.25],[0.1,0.4]], [[0.1,0.4],[0.2,0.5]], [[0.2,0.5],[0.8,0.5]], [[0.8,0.5],[0.9,0.6]], [[0.9,0.6],[0.9,0.8]], [[0.9,0.8],[0.8,0.9]], [[0.8,0.9],[0.2,0.9]], [[0.2,0.9],[0.1,0.85]]],
        'T': [[[0.1,0.1],[0.9,0.1]], [[0.5,0.1],[0.5,0.9]]],
        'U': [[[0.1,0.1],[0.1,0.75]], [[0.1,0.75],[0.2,0.9]], [[0.2,0.9],[0.8,0.9]], [[0.8,0.9],[0.9,0.75]], [[0.9,0.75],[0.9,0.1]]],
        'V': [[[0.1,0.1],[0.5,0.9]], [[0.5,0.9],[0.9,0.1]]],
        'W': [[[0.1,0.1],[0.25,0.9]], [[0.25,0.9],[0.5,0.45]], [[0.5,0.45],[0.75,0.9]], [[0.75,0.9],[0.9,0.1]]],
        'X': [[[0.1,0.1],[0.9,0.9]], [[0.9,0.1],[0.1,0.9]]],
        'Y': [[[0.1,0.1],[0.5,0.5]], [[0.9,0.1],[0.5,0.5]], [[0.5,0.5],[0.5,0.9]]],
        'Z': [[[0.1,0.1],[0.9,0.1]], [[0.9,0.1],[0.1,0.9]], [[0.1,0.9],[0.9,0.9]]],
        '-': [[[0.2,0.5],[0.8,0.5]]],
        '_': [[[0.1,0.9],[0.9,0.9]]],
        ' ': [],
      };

      function buildStrokeLabelEntities(text, layerName, placedPolygon) {
        const bbox = bboxFromPolygon(placedPolygon);
        if (!bbox) return [];
        const raw = String(text || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, ' ').trim();
        if (!raw) return [];

        const chars = [...raw];
        const glyphCount = chars.length;
        const charAdvance = 1.25;
        const textUnitsWide = Math.max(1, glyphCount * charAdvance - 0.25);
        const availableW = Math.max(10, bbox.maxX - bbox.minX);
        const availableH = Math.max(10, bbox.maxY - bbox.minY);
        const charH = Math.max(6, Math.min(20, Math.min(availableH * 0.18, availableW / textUnitsWide)));
        const charW = charH * 0.7;
        const totalW = glyphCount * charW * charAdvance - charW * 0.25;
        const startX = bbox.minX + (availableW - totalW) / 2;
        const baseY = bbox.minY + availableH * 0.58 - charH / 2;
        const entities = [];
        const style = exportSettings.engravingStyle === 'simple' ? 'simple' : 'stroked';

        const pushLoop = (loop, ox) => {
          if (!Array.isArray(loop) || loop.length < 2) return;
          for (let i = 0; i < loop.length; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % loop.length];
            entities.push({
              type: 'LINE',
              layer: layerName,
              start: { x: +(ox + a[0] * charW).toFixed(4), y: +(baseY + a[1] * charH).toFixed(4), z: 0 },
              end: { x: +(ox + b[0] * charW).toFixed(4), y: +(baseY + b[1] * charH).toFixed(4), z: 0 },
            });
          }
        };

        chars.forEach((ch, idx) => {
          const ox = startX + idx * charW * charAdvance;
          const loops = style === 'stroked' ? OUTLINE_FONT[ch] : null;
          if (Array.isArray(loops) && loops.length) {
            loops.forEach(loop => pushLoop(loop, ox));
            return;
          }
          const strokes = STROKE_FONT[ch] || [];
          strokes.forEach(([a, b]) => {
            entities.push({
              type: 'LINE',
              layer: layerName,
              start: { x: +(ox + a[0] * charW).toFixed(4), y: +(baseY + a[1] * charH).toFixed(4), z: 0 },
              end: { x: +(ox + b[0] * charW).toFixed(4), y: +(baseY + b[1] * charH).toFixed(4), z: 0 },
            });
          });
        });

        return entities;
      }

      function writeEntity(lines, entity, rotation, tx, ty, emitDebug = null, nextHandle = null) {
        if (!entity?.type) {
          if (emitDebug) emitDebug.skipped.push({ reason: 'missing-type', entity: entity || null });
          return false;
        }
        const layer = entity.layer || '0';
        const pushHeader = (typeName) => {
          lines.push('0', typeName);
          if (nextHandle) lines.push('5', nextHandle());
          lines.push('100', 'AcDbEntity');
          lines.push('8', layer);
        };

        if (entity.type === 'LINE') {
          const startPoint = entity.start || (Array.isArray(entity.vertices) && entity.vertices.length >= 2 ? entity.vertices[0] : null);
          const endPoint = entity.end || (Array.isArray(entity.vertices) && entity.vertices.length >= 2 ? entity.vertices[entity.vertices.length - 1] : null);
          if (!startPoint || !endPoint) {
            if (emitDebug) {
              emitDebug.skipped.push({
                reason: 'missing-geometry',
                type: entity.type,
                layer,
                hasStart: !!entity.start,
                hasEnd: !!entity.end,
                hasCenter: !!entity.center,
                radius: entity.radius ?? null,
                vertexCount: Array.isArray(entity.vertices) ? entity.vertices.length : 0,
                fitPointCount: Array.isArray(entity.fitPoints) ? entity.fitPoints.length : 0,
                controlPointCount: Array.isArray(entity.controlPoints) ? entity.controlPoints.length : 0,
              });
            }
            return false;
          }
          const start = transformPoint(startPoint, rotation, tx, ty);
          const end = transformPoint(endPoint, rotation, tx, ty);
          pushHeader('LINE');
          writeColor(lines, entity);
          lines.push('100', 'AcDbLine');
          lines.push('10', `${start.x}`, '20', `${start.y}`, '30', `${start.z || 0}`);
          lines.push('11', `${end.x}`, '21', `${end.y}`, '31', `${end.z || 0}`);
          if (emitDebug) emitDebug.emitted.LINE = (emitDebug.emitted.LINE || 0) + 1;
          return true;
        }

        if (entity.type === 'CIRCLE' && entity.center && Number.isFinite(entity.radius)) {
          const center = transformPoint(entity.center, rotation, tx, ty);
          pushHeader('CIRCLE');
          writeColor(lines, entity);
          lines.push('100', 'AcDbCircle');
          lines.push('10', `${center.x}`, '20', `${center.y}`, '30', `${center.z || 0}`);
          lines.push('40', `${entity.radius}`);
          if (emitDebug) emitDebug.emitted.CIRCLE = (emitDebug.emitted.CIRCLE || 0) + 1;
          return true;
        }

        if (entity.type === 'ARC' && entity.center && Number.isFinite(entity.radius)) {
          const center = transformPoint(entity.center, rotation, tx, ty);
          const startDeg = (((Number(entity.startAngle || 0)) + rotation) % 360 + 360) % 360;
          const endDeg = (((Number(entity.endAngle || 0)) + rotation) % 360 + 360) % 360;
          pushHeader('ARC');
          writeColor(lines, entity);
          lines.push('100', 'AcDbCircle');
          lines.push('100', 'AcDbArc');
          lines.push('10', `${center.x}`, '20', `${center.y}`, '30', `${center.z || 0}`);
          lines.push('40', `${entity.radius}`);
          lines.push('50', `${startDeg}`);
          lines.push('51', `${endDeg}`);
          if (emitDebug) emitDebug.emitted.ARC = (emitDebug.emitted.ARC || 0) + 1;
          return true;
        }

        if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && Array.isArray(entity.vertices) && entity.vertices.length >= 2) {
          const verts = entity.vertices;
          const count = verts.length;
          let lineCount = 0;
          for (let i = 0; i < count; i++) {
            const isLast = i === count - 1;
            if (isLast && !entity.closed) break;
            const a = verts[i];
            const b = verts[isLast ? 0 : i + 1];
            const bulge = Number.isFinite(a.bulge) ? a.bulge : 0;
            if (Math.abs(bulge) > 1e-9) {
              const x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
              const d = Math.hypot(x2 - x1, y2 - y1);
              const r = Math.abs(d * (1 + bulge * bulge) / (4 * bulge));
              const midX = (x1 + x2) / 2;
              const midY = (y1 + y2) / 2;
              const sagitta = bulge < 0 ? -r + Math.sqrt(r * r - (d / 2) * (d / 2)) : r - Math.sqrt(r * r - (d / 2) * (d / 2));
              const normX = -(y2 - y1) / d * Math.sign(bulge);
              const normY = (x2 - x1) / d * Math.sign(bulge);
              const cx = midX + normX * (r - Math.abs(sagitta));
              const cy = midY + normY * (r - Math.abs(sagitta));
              let startAngle = Math.atan2(y1 - cy, x1 - cx) * (180 / Math.PI);
              let endAngle = Math.atan2(y2 - cy, x2 - cx) * (180 / Math.PI);
              if (startAngle < 0) startAngle += 360;
              if (endAngle < 0) endAngle += 360;
              if (bulge < 0) { const tmp = startAngle; startAngle = endAngle; endAngle = tmp; }
              const cPt = transformPoint({ x: cx, y: cy, z: a.z || 0 }, rotation, tx, ty);
              const startRot = ((startAngle + rotation) % 360 + 360) % 360;
              const endRot = ((endAngle + rotation) % 360 + 360) % 360;
              pushHeader('ARC');
              writeColor(lines, entity);
              lines.push('100', 'AcDbCircle');
              lines.push('100', 'AcDbArc');
              lines.push('10', `${cPt.x}`, '20', `${cPt.y}`, '30', `${cPt.z || 0}`);
              lines.push('40', `${r}`);
              lines.push('50', `${startRot}`);
              lines.push('51', `${endRot}`);
              if (emitDebug) emitDebug.emitted.ARC = (emitDebug.emitted.ARC || 0) + 1;
            } else {
              const ptA = transformPoint({ x: a.x, y: a.y, z: a.z || 0 }, rotation, tx, ty);
              const ptB = transformPoint({ x: b.x, y: b.y, z: b.z || 0 }, rotation, tx, ty);
              pushHeader('LINE');
              writeColor(lines, entity);
              lines.push('10', `${ptA.x}`, '20', `${ptA.y}`, '30', `${ptA.z || 0}`);
              lines.push('11', `${ptB.x}`, '21', `${ptB.y}`, '31', `${ptB.z || 0}`);
              lineCount++;
            }
          }
          if (emitDebug) emitDebug.emitted.LINE = (emitDebug.emitted.LINE || 0) + lineCount;
          return true;
        }

        if (entity.type === 'ELLIPSE' && entity.center && entity.majorAxisEndPoint) {
          const center = transformPoint(entity.center, rotation, tx, ty);
          const major = rotateVector(entity.majorAxisEndPoint, rotation);
          pushHeader('ELLIPSE');
          writeColor(lines, entity);
          lines.push('100', 'AcDbEllipse');
          lines.push('10', `${center.x}`, '20', `${center.y}`, '30', `${center.z || 0}`);
          lines.push('11', `${major.x}`, '21', `${major.y}`, '31', `${major.z || 0}`);
          lines.push('40', `${entity.axisRatio || 1}`);
          if (Number.isFinite(entity.startParameter)) lines.push('41', `${entity.startParameter}`);
          if (Number.isFinite(entity.endParameter)) lines.push('42', `${entity.endParameter}`);
          if (emitDebug) emitDebug.emitted.ELLIPSE = (emitDebug.emitted.ELLIPSE || 0) + 1;
          return true;
        }

        if (entity.type === 'SPLINE' && (entity.controlPoints?.length || entity.fitPoints?.length)) {
          const controlPoints = (entity.controlPoints || []).map(point => transformPoint(point, rotation, tx, ty));
          const fitPoints = (entity.fitPoints || []).map(point => transformPoint(point, rotation, tx, ty));
          pushHeader('SPLINE');
          writeColor(lines, entity);
          lines.push('100', 'AcDbSpline');
          lines.push('70', entity.closed ? '1' : '0');
          lines.push('71', `${entity.degreeOfSplineCurve || 3}`);
          lines.push('72', `${(entity.knots || []).length}`);
          lines.push('73', `${controlPoints.length}`);
          lines.push('74', `${fitPoints.length}`);
          (entity.knots || []).forEach(knot => lines.push('40', `${knot}`));
          controlPoints.forEach(point => {
            lines.push('10', `${point.x}`, '20', `${point.y}`, '30', `${point.z || 0}`);
          });
          fitPoints.forEach(point => {
            lines.push('11', `${point.x}`, '21', `${point.y}`, '31', `${point.z || 0}`);
          });
          if (emitDebug) emitDebug.emitted.SPLINE = (emitDebug.emitted.SPLINE || 0) + 1;
          return true;
        }

        if (emitDebug) {
          emitDebug.skipped.push({
            reason: 'missing-geometry',
            type: entity.type,
            layer,
            hasStart: !!entity.start,
            hasEnd: !!entity.end,
            hasCenter: !!entity.center,
            radius: entity.radius ?? null,
            vertexCount: Array.isArray(entity.vertices) ? entity.vertices.length : 0,
            fitPointCount: Array.isArray(entity.fitPoints) ? entity.fitPoints.length : 0,
            controlPointCount: Array.isArray(entity.controlPoints) ? entity.controlPoints.length : 0,
          });
        }
        return false;
      }

      function isRenderableExportEntity(entity) {
        return ['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'ELLIPSE', 'SPLINE'].includes(entity?.type);
      }

      function buildDXF(sheetEntities, engravings, layerDefs, emitDebug) {
        const lines = [];
        const L = s => lines.push(s);
        let handleSeed = 0x100;
        const nextHandle = () => (handleSeed++).toString(16).toUpperCase();

        L('0'); L('SECTION');
        L('2'); L('HEADER');
        L('9'); L('$ACADVER');
        L('1'); L('AC1014');
        L('9'); L('$HANDSEED');
        L('5'); L('FFFF');
        L('0'); L('ENDSEC');

        L('0'); L('SECTION');
        L('2'); L('TABLES');

        L('0'); L('TABLE');
        L('2'); L('VPORT');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTable');
        L('70'); L('0');
        L('0'); L('ENDTAB');

        L('0'); L('TABLE');
        L('2'); L('LTYPE');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTable');
        L('70'); L('3');
        L('0'); L('LTYPE');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTableRecord');
        L('100'); L('AcDbLinetypeTableRecord');
        L('2'); L('BYBLOCK');
        L('70'); L('0');
        L('0'); L('LTYPE');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTableRecord');
        L('100'); L('AcDbLinetypeTableRecord');
        L('2'); L('BYLAYER');
        L('70'); L('0');
        L('0'); L('LTYPE');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTableRecord');
        L('100'); L('AcDbLinetypeTableRecord');
        L('2'); L('CONTINUOUS');
        L('70'); L('0');
        L('3'); L('Solid line');
        L('72'); L('65');
        L('73'); L('0');
        L('40'); L('0.0');
        L('0'); L('ENDTAB');

        L('0'); L('TABLE');
        L('2'); L('STYLE');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTable');
        L('70'); L('1');
        L('0'); L('STYLE');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTableRecord');
        L('100'); L('AcDbTextStyleTableRecord');
        L('2'); L('STANDARD');
        L('70'); L('0');
        L('40'); L('0.0');
        L('41'); L('1.0');
        L('50'); L('0.0');
        L('71'); L('0');
        L('42'); L('1.0');
        L('3'); L('');
        L('4'); L('');
        L('0'); L('ENDTAB');

        L('0'); L('TABLE');
        L('2'); L('VIEW');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTable');
        L('70'); L('0');
        L('0'); L('ENDTAB');

        L('0'); L('TABLE');
        L('2'); L('UCS');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTable');
        L('70'); L('0');
        L('0'); L('ENDTAB');

        L('0'); L('TABLE');
        L('2'); L('APPID');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTable');
        L('70'); L('1');
        L('0'); L('APPID');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTableRecord');
        L('100'); L('AcDbRegAppTableRecord');
        L('2'); L('ACAD');
        L('70'); L('0');
        L('0'); L('ENDTAB');

        L('0'); L('TABLE');
        L('2'); L('DIMSTYLE');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTable');
        L('70'); L('0');
        L('0'); L('ENDTAB');

        L('0'); L('TABLE');
        L('2'); L('BLOCK_RECORD');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTable');
        L('70'); L('2');
        L('0'); L('BLOCK_RECORD');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTableRecord');
        L('100'); L('AcDbBlockTableRecord');
        L('2'); L('*MODEL_SPACE');
        L('0'); L('BLOCK_RECORD');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTableRecord');
        L('100'); L('AcDbBlockTableRecord');
        L('2'); L('*PAPER_SPACE');
        L('0'); L('ENDTAB');

        L('0'); L('TABLE');
        L('2'); L('LAYER');
        L('5'); L(nextHandle());
        L('100'); L('AcDbSymbolTable');
        L('70'); L(String(layerDefs.length));
        layerDefs.forEach(layer => {
          L('0'); L('LAYER');
          L('5'); L(nextHandle());
          L('100'); L('AcDbSymbolTableRecord');
          L('100'); L('AcDbLayerTableRecord');
          L('2'); L(layer.name);
          L('70'); L('0');
          L('62'); L(String(approxAciFromHex(layer.color)));
          L('6'); L('CONTINUOUS');
        });
        L('0'); L('ENDTAB');

        L('0'); L('ENDSEC');

        L('0'); L('SECTION');
        L('2'); L('BLOCKS');
        L('0'); L('BLOCK');
        L('5'); L(nextHandle());
        L('100'); L('AcDbEntity');
        L('100'); L('AcDbBlockBegin');
        L('8'); L('0');
        L('2'); L('*MODEL_SPACE');
        L('70'); L('0');
        L('10'); L('0');
        L('20'); L('0');
        L('30'); L('0');
        L('3'); L('*MODEL_SPACE');
        L('1'); L('');
        L('0'); L('ENDBLK');
        L('5'); L(nextHandle());
        L('100'); L('AcDbEntity');
        L('100'); L('AcDbBlockEnd');
        L('8'); L('0');
        L('0'); L('BLOCK');
        L('5'); L(nextHandle());
        L('100'); L('AcDbEntity');
        L('100'); L('AcDbBlockBegin');
        L('8'); L('0');
        L('2'); L('*PAPER_SPACE');
        L('70'); L('0');
        L('10'); L('0');
        L('20'); L('0');
        L('30'); L('0');
        L('3'); L('*PAPER_SPACE');
        L('1'); L('');
        L('0'); L('ENDBLK');
        L('5'); L(nextHandle());
        L('100'); L('AcDbEntity');
        L('100'); L('AcDbBlockEnd');
        L('8'); L('0');
        L('0'); L('ENDSEC');

        L('0'); L('SECTION');
        L('2'); L('ENTITIES');

        sheetEntities.forEach(entity => writeEntity(lines, entity.entity, entity.rotation, entity.tx, entity.ty, emitDebug, nextHandle));
        engravings.forEach(engraving => {
          if (engraving.engravingLayer && engraving.placedPolygon?.length) {
            const labelEntities = buildStrokeLabelEntities(
              engraving.label,
              engraving.engravingLayer,
              engraving.placedPolygon,
            );
            labelEntities.forEach(entity => {
              writeEntity(lines, entity, 0, 0, 0, emitDebug, nextHandle);
            });
          }
        });

        L('0'); L('ENDSEC');

        const namedObjHandle = nextHandle();
        const groupDictHandle = nextHandle();
        L('0'); L('SECTION');
        L('2'); L('OBJECTS');
        L('0'); L('DICTIONARY');
        L('5'); L(namedObjHandle);
        L('100'); L('AcDbDictionary');
        L('281'); L('1');
        L('3'); L('ACAD_GROUP');
        L('350'); L(groupDictHandle);
        L('0'); L('DICTIONARY');
        L('5'); L(groupDictHandle);
        L('330'); L(namedObjHandle);
        L('100'); L('AcDbDictionary');
        L('281'); L('1');
        L('0'); L('ENDSEC');

        L('0'); L('EOF');

        return lines.join('\n');
      }

      let fileCount = 0;

      for (const strip of strips) {
        if (!strip.json_path || !fs.existsSync(strip.json_path)) continue;

        let stripData;
        try {
          stripData = JSON.parse(fs.readFileSync(strip.json_path, 'utf-8'));
        } catch (e) {
          continue;
        }

        const placedItems = stripData.solution?.layout?.placed_items || [];
        const sheetEntities = [];
        const engravings = [];
        const debugRows = [];
        const emitDebug = { emitted: {}, skipped: [] };

        placedItems.forEach(placement => {
          const exportItem = exportItems?.[placement.item_id] || null;
          const item = {
            ...globalItemsById[placement.item_id],
            export: exportItem,
          };
          if (!item?.shape?.data) return;
          const { rotation, translation: [tx, ty] } = placement.transformation;
          const sourcePolygon = item.export?.polygon || item.shape.data;
          const transformed = applyTransform(sourcePolygon, rotation, tx, ty);
          const pts = transformed[0] && transformed[transformed.length - 1] &&
            Math.abs(transformed[0][0] - transformed[transformed.length - 1][0]) < 0.01 &&
            Math.abs(transformed[0][1] - transformed[transformed.length - 1][1]) < 0.01
            ? transformed.slice(0, -1) : transformed;
          engravings.push({
            rotation,
            placedPolygon: pts,
            engravingLayer: getEngravingLayer(item)?.name || null,
            label: labelForItem(item),
          });
          const entities = (item.export?.entities || []).filter(isRenderableExportEntity);
          let usedFallback = false;
          if (entities.length) {
            entities.forEach(entity => {
              sheetEntities.push({
                entity,
                rotation,
                tx,
                ty,
              });
            });
          } else {
            usedFallback = true;
            sheetEntities.push({
              entity: {
                type: 'LWPOLYLINE',
                layer: '0',
                closed: true,
                vertices: pts.map(([x, y]) => ({ x, y, z: 0 })),
              },
              rotation: 0,
              tx: 0,
              ty: 0,
            });
          }

          debugRows.push({
            item_id: placement.item_id,
            has_global_item: !!globalItemsById[placement.item_id],
            has_export_item: !!exportItem,
            source_name: exportItem?.source_name || item?.dxf || null,
            export_layer_count: Array.isArray(exportItem?.layers) ? exportItem.layers.length : 0,
            export_entity_count: Array.isArray(exportItem?.entities) ? exportItem.entities.length : 0,
            renderable_entity_count: entities.length,
            polygon_point_count: Array.isArray(sourcePolygon) ? sourcePolygon.length : 0,
            used_fallback_polygon: usedFallback,
            engraving_layer: getEngravingLayer(item)?.name || null,
            label: labelForItem(item),
            rotation,
            translation: [tx, ty],
          });
        });

        const idx = String(strip.index).padStart(2, '0');
        const layerDefs = collectLayerDefs([{ placedItems }]);
        const dxf = buildDXF(sheetEntities, engravings, layerDefs, emitDebug);
        const outPath = path.join(outputDir, `${safeName}_sheet_${idx}.dxf`);
        fs.writeFileSync(outPath, dxf, 'utf-8');
        const debugPath = path.join(outputDir, `${safeName}_sheet_${idx}.debug.json`);
        fs.writeFileSync(debugPath, JSON.stringify({
          strip_index: strip.index,
          strip_json_path: strip.json_path,
          input_path: inputPath || null,
          sheet_width_mode: strip.sheet_width_mode || null,
          sheet_width: strip.sheet_width ?? null,
          strip_width: strip.strip_width ?? null,
          strip_height: strip.strip_height ?? null,
          export_item_key_count: Object.keys(exportItems || {}).length,
          placed_item_count: placedItems.length,
          sheet_entity_count: sheetEntities.length,
          engraving_count: engravings.length,
          emitted_entity_counts: emitDebug.emitted,
          skipped_entity_count: emitDebug.skipped.length,
          skipped_entity_samples: emitDebug.skipped.slice(0, 40),
          layer_defs: layerDefs,
          rows: debugRows,
        }, null, 2), 'utf-8');
        fileCount++;
      }

      return { success: true, fileCount, outputDir };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerExportDxfIpc,
};
