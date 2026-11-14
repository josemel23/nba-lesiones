#!/usr/bin/env node
/* ============================================================
   enriquecer.js — se ejecuta DESPUÉS de scrape.js
     node scrape.js && node enriquecer.js

   1) Lleva un registro (estado-lesiones.json) de cada jugador lesionado:
      desde cuándo aparece y cuándo dejó de aparecer.
   2) Detecta REGRESOS: quien estaba en la lista y ya no está -> regresos.json
   3) Añade a cada jugador de lesiones.json sus estadísticas de la temporada
      (pts, reb, ast, min...) y los días que lleva fuera.
   Necesita Node 18+ (usa fetch). No requiere paquetes.
   ============================================================ */
const fs = require("fs");
const path = require("path");

const F_LES = path.join(__dirname, "lesiones.json");
const F_REG = path.join(__dirname, "regresos.json");
const F_EST = path.join(__dirname, "estado-lesiones.json");
const DIA = 864e5;
const AHORA = Date.now();
const ISO = new Date(AHORA).toISOString();

function leer(f, def) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return def; } }
function escribir(f, obj) {
  fs.writeFileSync(f + ".tmp", JSON.stringify(obj, null, 2));
  fs.renameSync(f + ".tmp", f);
}

// Promedios por partido de la temporada actual (ESPN)
async function statsJugador(id) {
  const url = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/" + id + "/overview";
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  const st = d && d.statistics;
  if (!st || !Array.isArray(st.splits) || !st.splits.length) return null;
  const split = st.splits.find(function (s) { return /regular/i.test(s.displayName || ""); }) || st.splits[0];
  if (!split || !Array.isArray(split.stats)) return null;
  const val = function (label, name) {
    let i = (st.labels || []).indexOf(label);
    if (i < 0) i = (st.names || []).indexOf(name);
    const v = i >= 0 ? parseFloat(split.stats[i]) : NaN;
    return isNaN(v) ? null : v;
  };
  const s = {
    gp: val("GP", "gamesPlayed"), mpg: val("MIN", "avgMinutes"), ppg: val("PTS", "avgPoints"),
    rpg: val("REB", "avgRebounds"), apg: val("AST", "avgAssists"), spg: val("STL", "avgSteals"), bpg: val("BLK", "avgBlocks")
  };
  return s.ppg == null ? null : s;
}

async function conLimite(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async function () {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  });
  await Promise.all(workers);
}

(async function main() {
  const les = leer(F_LES, null);
  if (!les || !Array.isArray(les.jugadores)) { console.error("lesiones.json no existe o no es válido"); process.exit(1); }
  const est = leer(F_EST, { jugadores: {} });
  const L = est.jugadores = est.jugadores || {};
  const ids = new Set(les.jugadores.map(function (j) { return String(j.espnId); }));

  // 1) Registro de lesionados activos
  les.jugadores.forEach(function (j) {
    const id = String(j.espnId);
    let e = L[id];
    if (!e || !e.activo) {
      // Si había "regresado" hace menos de 2 días, se trata como la misma lesión (el scraper pudo fallar un rato)
      if (e && e.regresoReal && AHORA - Date.parse(e.regresoReal) < 2 * DIA) { e.activo = true; delete e.regresoReal; }
      else e = { primeraVez: ISO, stats: (e && e.stats) || null, statsTs: (e && e.statsTs) || 0 };
    }
    Object.assign(e, { activo: true, nombre: j.nombre, equipo: j.equipo, abrev: j.abrev, pos: j.pos, ultimaVez: ISO });
    L[id] = e;
  });

  // 2) Regresos: estaban y ya no están. Solo si el scraper trajo una lista creíble (no vacía por un fallo)
  const fiable = les.jugadores.length >= 20;
  if (!fiable) console.warn("Lista de lesiones muy corta: no se marcan regresos en esta corrida.");
  Object.keys(L).forEach(function (id) {
    const e = L[id];
    if (fiable && e.activo && !ids.has(id)) {
      e.activo = false;
      e.regresoReal = ISO;
      e.diasFuera = Math.round((AHORA - Date.parse(e.primeraVez)) / DIA);
      console.log("Regresó:", e.nombre, "(" + e.equipo + ") tras", e.diasFuera, "días");
    }
  });

  // 3) Estadísticas (se refrescan como máximo cada 20 h por jugador)
  const pendientes = les.jugadores.filter(function (j) {
    const e = L[String(j.espnId)];
    return !e.stats || AHORA - (e.statsTs || 0) > 20 * 3600 * 1000;
  });
  let fallos = 0;
  await conLimite(pendientes, 6, async function (j) {
    const e = L[String(j.espnId)];
    try {
      const s = await statsJugador(j.espnId);
      if (s) { e.stats = s; }
      e.statsTs = AHORA;
    } catch (err) {
      fallos++;
      console.warn("Sin stats de", j.nombre, "-", err.message);
    }
  });
  console.log("Stats actualizadas:", pendientes.length - fallos, "de", pendientes.length);

  les.jugadores.forEach(function (j) {
    const e = L[String(j.espnId)];
    j.stats = e.stats || null;
    j.diasFuera = Math.floor((AHORA - Date.parse(e.primeraVez)) / DIA);
  });
  les.enriquecido = ISO;

  // Regresos de los últimos 14 días
  const regresos = Object.keys(L).filter(function (id) {
    const e = L[id];
    return !e.activo && e.regresoReal && AHORA - Date.parse(e.regresoReal) <= 14 * DIA;
  }).map(function (id) {
    const e = L[id];
    return { espnId: id, nombre: e.nombre, equipo: e.equipo, abrev: e.abrev, pos: e.pos, regresoReal: e.regresoReal, diasFuera: e.diasFuera, stats: e.stats || null };
  });

  // Limpieza: se olvidan los regresos de hace más de 45 días
  Object.keys(L).forEach(function (id) {
    const e = L[id];
    if (!e.activo && e.regresoReal && AHORA - Date.parse(e.regresoReal) > 45 * DIA) delete L[id];
  });

  est.actualizado = ISO;
  escribir(F_LES, les);
  escribir(F_REG, { actualizado: ISO, regresos: regresos });
  escribir(F_EST, est);
  console.log("Listo. Lesionados:", les.jugadores.length, "| Regresos recientes:", regresos.length);
})().catch(function (e) { console.error(e); process.exit(1); });