'use strict';
// Baut daten/kartenstil.json aus dem OpenFreeMap-Stil "liberty" (daten/kartenstil-original.json):
// - alle Beschriftungen einheitlich: deutscher Name, sonst lateinische Schreibweise
//   (statt Kyrillisch, Arabisch, Chinesisch … neben- oder untereinander)
// - Kacheln, Schriften und Symbole kommen über den eigenen Server (/vkarte/…)
// Aufruf: node werkzeug/kartenstil-bauen.js
const fs = require('fs');
const path = require('path');

const daten = path.join(__dirname, '..', 'daten');
const stil = JSON.parse(fs.readFileSync(path.join(daten, 'kartenstil-original.json'), 'utf8'));

const NAME = ['coalesce', ['get', 'name:de'], ['get', 'name_de'], ['get', 'name:latin'], ['get', 'name_en'], ['get', 'name']];
let ersetzt = 0;
for (const l of stil.layers){
  const t = l.layout && l.layout['text-field'];
  if (t && JSON.stringify(t).includes('"name')){ l.layout['text-field'] = NAME; ersetzt++; }
}

const NACHWEIS = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> '
  + '© <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> '
  + 'Daten von <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
// Pfade relativ; der Browser setzt beim Laden die eigene Adresse davor
stil.sources = {
  ne2_shaded:{ type:'raster', tiles:['/vkarte/ne2sr/{z}/{x}/{y}.png'], tileSize:256, maxzoom:6 },
  openmaptiles:{ type:'vector', tiles:['/vkarte/tiles/{z}/{x}/{y}.pbf'], minzoom:0, maxzoom:14, attribution:NACHWEIS }
};
stil.glyphs = '/vkarte/fonts/{fontstack}/{range}.pbf';
stil.sprite = '/vkarte/sprites/ofm';
fs.writeFileSync(path.join(daten, 'kartenstil.json'), JSON.stringify(stil));
console.log(`${ersetzt} Beschriftungsebenen vereinheitlicht, Stil geschrieben.`);
