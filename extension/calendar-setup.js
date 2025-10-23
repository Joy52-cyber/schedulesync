function setStatus(t) { document.getElementById("status").textContent = t || ""; }

function renderEvents(items, provider) {
  const c = document.getElementById("events");
  if (!Array.isArray(items) || !items.length) {
    c.innerHTML = `<p>No upcoming events from ${provider}.</p>`;
    return;
  }
  c.innerHTML = items.map(ev => {
    let title, start, end, loc;
    if (provider === "Google") {
      title = ev.summary || "(no title)";
      start = ev.start?.dateTime || ev.start?.date || "";
      end   = ev.end?.dateTime   || ev.end?.date   || "";
      loc   = ev.location || "";
    } else {
      title = ev.subject || "(no title)";
      start = ev.start?.dateTime || "";
      end   = ev.end?.dateTime   || "";
      loc   = ev.location?.displayName || "";
    }
    return `<article><h5>${title}</h5>
      <p><strong>Start:</strong> ${start}<br><strong>End:</strong> ${end}<br>
      <strong>Location:</strong> ${loc || "—"}</p></article>`;
  }).join("");
}

function bg(msg) {
  return new Promise(res => chrome.runtime.sendMessage(msg, res));
}

document.getElementById("googleConnect").addEventListener("click", async () => {
  setStatus("Connecting Google…");
  const r = await bg({ type: "GOOGLE_LOGIN" });
  setStatus(r.ok ? "Google connected." : `Google error: ${r.error}`);
});

document.getElementById("googleLoad").addEventListener("click", async () => {
  setStatus("Loading Google events…");
  const r = await bg({ type: "GOOGLE_EVENTS" });
  if (r.ok) { const items = r.data?.items || []; renderEvents(items, "Google"); setStatus(`Loaded ${items.length} Google events.`); }
  else setStatus(`Google load error: ${r.error}`);
});

document.getElementById("msConnect").addEventListener("click", async () => {
  setStatus("Connecting Microsoft…");
  const r = await bg({ type: "MS_LOGIN" });
  setStatus(r.ok ? "Microsoft connected." : `Microsoft error: ${r.error}`);
});

document.getElementById("msLoad").addEventListener("click", async () => {
  setStatus("Loading Microsoft events…");
  const r = await bg({ type: "MS_EVENTS" });
  if (r.ok) { const items = r.data?.value || []; renderEvents(items, "Microsoft"); setStatus(`Loaded ${items.length} MS events.`); }
  else setStatus(`MS load error: ${r.error}`);
});

document.getElementById("logout").addEventListener("click", async () => {
  await bg({ type: "LOGOUT" });
  document.getElementById("events").innerHTML = "";
  setStatus("Disconnected.");
});
