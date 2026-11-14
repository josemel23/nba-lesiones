// scrape.js — Baja las lesiones de la NBA desde ESPN (JSON) y las guarda en lesiones.json
// Uso:  node scrape.js
// Requiere Node 18 o más. No necesita instalar nada (npm install no hace falta).

const fs = require("fs");

const URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries";

// Frases de los comentarios de ESPN que ayudan a afinar el estado
const RE_OUT = /ruled out|will not play|won'?t play|listed as out|is out\b|doubtful/i;
const RE_DUDA = /questionable/i;
const RE_PROBABLE = /probable|is available|expected to play/i;

// nivel: "out" (fuera) | "duda" | "probable" | "dia_a_dia" (sin más información)
function nivelDe(estado, fantasy, comentario) {
  const e = String(estado || "").trim().toLowerCase();
  const f = String(fantasy || "").trim().toUpperCase();
  const c = String(comentario || "");
  if (e === "out" || f === "OUT" || f === "OFS") return "out";
  if (RE_OUT.test(c)) return "out";
  if (RE_DUDA.test(c)) return "duda";
  if (RE_PROBABLE.test(c)) return "probable";
  return "dia_a_dia";
}

// Convierte la respuesta de ESPN en una lista plana de jugadores
function parsear(json) {
  const lista = [];
  ((json && json.injuries) || []).forEach(function (eq) {
    (eq.injuries || []).forEach(function (i) {
      const a = i.athlete || {};
      const t = a.team || {};
      const det = i.details || {};
      const fantasy = (det.fantasyStatus && det.fantasyStatus.description) || "";
      const card = (a.links || []).find(function (l) { return (l.rel || []).indexOf("playercard") > -1; });
      const m = card && /\/id\/(\d+)\//.exec(card.href || "");
      lista.push({
        equipo: t.displayName || eq.displayName || "?",
        abrev: t.abbreviation || "",
        nombre: a.displayName || "?",
        espnId: m ? m[1] : "",
        pos: (a.position && a.position.abbreviation) || "",
        estado: i.status || "",
        fantasy: fantasy,
        fueraTemporada: fantasy === "OFS",
        lesion: det.type || "",
        regreso: det.returnDate || "",
        fecha: i.date || "",
        comentario: i.shortComment || "",
        nivel: nivelDe(i.status, fantasy, i.shortComment)
      });
    });
  });
  return lista;
}

async function main() {
  const r = await fetch(URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "application/json"
    }
  });
  console.log("Respuesta de ESPN: HTTP", r.status);
  const texto = await r.text();

  let json;
  try { json = JSON.parse(texto); }
  catch (e) {
    console.log("La respuesta no es JSON. Primeros 400 caracteres:\n");
    console.log(texto.slice(0, 400));
    process.exitCode = 1;
    return;
  }

  const lista = parsear(json);
  if (!lista.length) {
    console.log("El JSON llegó, pero no se encontraron jugadores lesionados.");
    process.exitCode = 1;
    return;
  }

  const salida = {
    actualizado: new Date().toISOString(),
    fuente: URL,
    espnTimestamp: json.timestamp || "",
    total: lista.length,
    jugadores: lista
  };
  fs.writeFileSync("lesiones.json", JSON.stringify(salida, null, 2), "utf8");

  const cuenta = {};
  lista.forEach(function (j) { cuenta[j.nivel] = (cuenta[j.nivel] || 0) + 1; });
  const equipos = new Set(lista.map(function (j) { return j.equipo; })).size;
  console.log("Listo: " + lista.length + " jugadores de " + equipos + " equipos guardados en lesiones.json");
  console.log("Por nivel:", cuenta);
}

if (require.main === module) {
  main().catch(function (e) {
    console.error("Error:", e.message);
    process.exitCode = 1;
  });
}

module.exports = { parsear: parsear, nivelDe: nivelDe };