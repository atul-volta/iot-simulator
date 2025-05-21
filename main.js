let meters = [];
let meterCount = 0;
let flowCharts = {};
let totalCharts = {};
let mqttClients = {};

function addMeter() {
  meterCount++;
  const meterId = "WM-" + String(meterCount).padStart(3, "0");
  meters.push({
    id: meterId,
    profile: "residential",
    interval: 10,
    timer: null,
    totalVolume: 0,
    data: [],
    chartLabels: [],
    flowPoints: [],
    totalPoints: [],
    mqttEnabled: false,
    mqttBroker: "wss://broker.hivemq.com:8884/mqtt",
    mqttTopic: `iot/watermeter/${meterId}`,
    leakProb: 2,
    burstProb: 1,
    reverseProb: 0.5,
    offlineProb: 0.5,
    injectNext: "",
  });
  renderMeters();
}

function removeMeter(index) {
  clearInterval(meters[index].timer);
  let meterId = meters[index].id;
  if (flowCharts[meterId]) {
    flowCharts[meterId].destroy();
    delete flowCharts[meterId];
  }
  if (totalCharts[meterId]) {
    totalCharts[meterId].destroy();
    delete totalCharts[meterId];
  }
  if (mqttClients[meterId]) {
    mqttClients[meterId].end?.();
    delete mqttClients[meterId];
  }
  meters.splice(index, 1);
  renderMeters();
}

function startMeter(index) {
  const meter = meters[index];
  if (meter.timer) return;
  generateMeterData(meter, true); // Generate first point
  // Start periodic updates
  meter.timer = setInterval(() => {
    generateMeterData(meter, false);
    renderMeters();
  }, meter.interval * 1000);
  renderMeters(); // Ensure DOM/canvases are present
}

function stopMeter(index) {
  clearInterval(meters[index].timer);
  meters[index].timer = null;
  renderMeters();
}

function injectFault(index) {
  const select = document.getElementById(`injectFault-${meters[index].id}`);
  if (select) {
    meters[index].injectNext = select.value;
    select.value = "";
  }
}

function getRandomStatus(meter) {
  const r = Math.random() * 100;
  if (r < meter.leakProb) return "low flow";
  if (r < meter.leakProb + meter.burstProb) return "burst";
  if (r < meter.leakProb + meter.burstProb + meter.reverseProb) return "reverse flow";
  if (r < meter.leakProb + meter.burstProb + meter.reverseProb + meter.offlineProb) return "offline";
  return "normal";
}

function generateMeterData(meter, isFirst) {
  let status = "normal";
  if (meter.injectNext) {
    status = {
      leak: "low flow",
      burst: "burst",
      reverse: "reverse flow",
      offline: "offline"
    }[meter.injectNext] || "normal";
    meter.injectNext = "";
  } else if (!isFirst) {
    status = getRandomStatus(meter);
  }
  let flowRate = getFlowRate(meter.profile, status);
  if (status === "offline") flowRate = 0;
  meter.totalVolume += (flowRate * meter.interval) / 60;
  const now = new Date();
  const label = now.toLocaleTimeString();
  meter.data.unshift({
    time: label,
    flow: flowRate,
    total: meter.totalVolume.toFixed(2),
    status: status
  });
  if (meter.chartLabels.length >= 30) {
    meter.chartLabels.pop();
    meter.flowPoints.pop();
    meter.totalPoints.pop();
  }
  meter.chartLabels.unshift(label);
  meter.flowPoints.unshift(flowRate);
  meter.totalPoints.unshift(meter.totalVolume);

  if (meter.mqttEnabled && meter.mqttBroker && meter.mqttTopic) {
    if (!mqttClients[meter.id] || !mqttClients[meter.id].connected) {
      try {
        mqttClients[meter.id]?.end?.();
        mqttClients[meter.id] = mqtt.connect(meter.mqttBroker, { reconnectPeriod: 2000 });
        mqttClients[meter.id].on('connect', () => {
          updateMqttStatus(meter.id, "Connected");
        });
        mqttClients[meter.id].on('error', (err) => {
          updateMqttStatus(meter.id, "Error: " + err.message);
        });
        mqttClients[meter.id].on('close', () => {
          updateMqttStatus(meter.id, "Disconnected");
        });
      } catch (e) {
        updateMqttStatus(meter.id, "MQTT Error: " + e.message);
        return;
      }
    }
    const msg = {
      meter_id: meter.id,
      timestamp: new Date().toISOString(),
      flow_rate_lpm: meter.flowPoints[0],
      total_volume_l: meter.totalPoints[0],
      status: status
    };
    try {
      mqttClients[meter.id].publish(meter.mqttTopic, JSON.stringify(msg));
      updateMqttStatus(meter.id, "Published");
    } catch (e) {
      updateMqttStatus(meter.id, "Publish Error");
    }
  }
}

function getFlowRate(profile, status) {
  const hour = new Date().getHours();
  let base = 0;
  if (profile === "residential") {
    if ((hour >= 6 && hour <= 8) || (hour >= 18 && hour <= 21))
      base = Math.random() * 10 + 5;
    else if (hour >= 22 || hour <= 5)
      base = Math.random() < 0.8 ? 0 : Math.random() * 2;
    else
      base = Math.random() * 3;
  } else {
    if (hour >= 8 && hour <= 18)
      base = Math.random() * 8 + 3;
    else
      base = Math.random() < 0.9 ? 0 : Math.random() * 2;
  }
  if (status === "low flow") return Math.random() * 0.5 + 0.01;
  if (status === "burst") return base * (2.2 + Math.random() * 1.3);
  if (status === "reverse flow") return -1 * (Math.random() * 2 + 0.1);
  if (status === "offline") return 0;
  return base;
}

function renderMeters() {
  const metersDiv = document.getElementById("meters");
  metersDiv.innerHTML = "";
  meters.forEach((meter, idx) => {
    const meterDiv = document.createElement("div");
    meterDiv.className = "meter-card";
    meterDiv.innerHTML = `
      <div class="inline-row">
        <label><strong>Meter ID:</strong>
          <input value="${meter.id}" onchange="meters[${idx}].id=this.value">
        </label>
        <label>Profile:
          <select onchange="meters[${idx}].profile=this.value">
            <option value="residential" ${meter.profile==="residential"?"selected":""}>Residential</option>
            <option value="commercial" ${meter.profile==="commercial"?"selected":""}>Commercial</option>
          </select>
        </label>
        <label>Interval (sec):
          <input type="number" min="1" value="${meter.interval}" onchange="meters[${idx}].interval=parseInt(this.value,10)">
        </label>
        <button class="btn-blue" onclick="startMeter(${idx})" ${meter.timer ? "disabled" : ""}>Start</button>
        <button class="btn-blue" onclick="stopMeter(${idx})" ${meter.timer ? "" : "disabled"}>Stop</button>
        <button class="btn-blue" onclick="removeMeter(${idx})">Remove</button>
      </div>
      <div class="collapsible-section">
        <button class="collapsible-toggle" type="button" aria-expanded="false">
          <span class="chevron">&#9654;</span>
          MQTT Settings <small style="font-weight:normal;margin-left:0.5em;">(optional)</small>
        </button>
        <div class="collapsible-content">
          <div class="inline-row">
            <label>Broker URL:
              <input type="text" value="${meter.mqttBroker}" onchange="meters[${idx}].mqttBroker=this.value">
            </label>
            <label>Topic:
              <input type="text" value="${meter.mqttTopic}" onchange="meters[${idx}].mqttTopic=this.value">
            </label>
            <label style="margin-right:0;">
              <input type="checkbox" ${meter.mqttEnabled ? "checked" : ""} onchange="meters[${idx}].mqttEnabled=this.checked">
              Enable
            </label>
          </div>
          <div class="form-row">
            <span>MQTT Export</span>
            <span id="mqttStatus-${meter.id}" class="mqtt-status"></span>
          </div>
        </div>
      </div>
      <div class="collapsible-section">
        <button class="collapsible-toggle" type="button" aria-expanded="false">
          <span class="chevron">&#9654;</span>
          Status Anomaly Probabilities & Fault Injection
        </button>
        <div class="collapsible-content">
          <div class="inline-row">
            <label>Leak (%):
              <input type="number" min="0" max="100" step="0.1" value="${meter.leakProb}" onchange="meters[${idx}].leakProb=parseFloat(this.value)">
            </label>
            <label>Burst (%):
              <input type="number" min="0" max="100" step="0.1" value="${meter.burstProb}" onchange="meters[${idx}].burstProb=parseFloat(this.value)">
            </label>
            <label>Reverse Flow (%):
              <input type="number" min="0" max="100" step="0.1" value="${meter.reverseProb}" onchange="meters[${idx}].reverseProb=parseFloat(this.value)">
            </label>
            <label>Offline (%):
              <input type="number" min="0" max="100" step="0.1" value="${meter.offlineProb}" onchange="meters[${idx}].offlineProb=parseFloat(this.value)">
            </label>
          </div>
          <div class="form-row">
            <label>Inject Fault: 
              <select id="injectFault-${meter.id}">
                <option value="">-- select --</option>
                <option value="leak">leak</option>
                <option value="burst">burst</option>
                <option value="reverse">reverse flow</option>
                <option value="offline">offline</option>
              </select>
            </label>
            <button class="btn-blue" onclick="injectFault(${idx})">Inject</button>
            <span style="color:#c47817;font-size:0.98em;">(injects for next reading)</span>
          </div>
        </div>
      </div>
      <div class="export-btns">
        <button class="btn-blue" onclick="exportCSV(${idx})">Export CSV</button>
        <button class="btn-blue" onclick="exportJSON(${idx})">Export JSON</button>
      </div>
      <div class="chart-container">
        <div>
          <small>Flow Rate (L/min)</small>
          <canvas id="flowChart-${meter.id}" width="280" height="110"></canvas>
        </div>
        <div>
          <small>Total Volume (L)</small>
          <canvas id="totalChart-${meter.id}" width="280" height="110"></canvas>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Flow Rate</th>
            <th>Total Volume</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${meter.data.slice(0,5).map(d => `
            <tr>
              <td>${d.time}</td>
              <td>${d.flow.toFixed(2)}</td>
              <td>${d.total}</td>
              <td>${d.status}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    metersDiv.appendChild(meterDiv);
  });

  // --- Always redraw all charts after DOM is ready
  setTimeout(() => {
    meters.forEach(meter => {
      drawOrUpdateChart(meter);
    });
  }, 0);
}

function drawOrUpdateChart(meter) {
  const flowCanvas = document.getElementById(`flowChart-${meter.id}`);
  const flowLabels = meter.chartLabels.length ? meter.chartLabels.slice().reverse() : [""];
  const flowPoints = meter.flowPoints.length ? meter.flowPoints.slice().reverse() : [0];
  if (flowCharts[meter.id]) {
    flowCharts[meter.id].destroy();
    delete flowCharts[meter.id];
  }
  if (flowCanvas) {
    flowCharts[meter.id] = new Chart(flowCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: flowLabels,
        datasets: [{
          label: 'Flow Rate',
          data: flowPoints,
          fill: false,
          borderColor: 'rgba(50,102,244,0.8)',
          tension: 0.3,
        }]
      },
      options: {
        animation: false,
        plugins: { legend: { display: false }},
        scales: { x: { display: false }, y: { beginAtZero: true } }
      }
    });
  }
  const totalCanvas = document.getElementById(`totalChart-${meter.id}`);
  const totalLabels = meter.chartLabels.length ? meter.chartLabels.slice().reverse() : [""];
  const totalPoints = meter.totalPoints.length ? meter.totalPoints.slice().reverse() : [0];
  if (totalCharts[meter.id]) {
    totalCharts[meter.id].destroy();
    delete totalCharts[meter.id];
  }
  if (totalCanvas) {
    totalCharts[meter.id] = new Chart(totalCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: totalLabels,
        datasets: [{
          label: 'Total Volume',
          data: totalPoints,
          fill: true,
          borderColor: 'rgba(61,184,116,0.9)',
          backgroundColor: 'rgba(61,184,116,0.12)',
          tension: 0.3,
        }]
      },
      options: {
        animation: false,
        plugins: { legend: { display: false }},
        scales: { x: { display: false }, y: { beginAtZero: true } }
      }
    });
  }
}

function updateMqttStatus(meterId, msg) {
  const el = document.getElementById("mqttStatus-" + meterId);
  if (el) el.textContent = msg;
}

function exportCSV(index) {
  const meter = meters[index];
  if (!meter || meter.data.length === 0) return;
  const headers = ["Timestamp", "Flow Rate (L/min)", "Total Volume (L)", "Status"];
  const rows = meter.data.map(d => [d.time, d.flow.toFixed(2), d.total, d.status]);
  let csvContent = headers.join(",") + "\n" +
    rows.map(e => e.join(",")).join("\n");
  const blob = new Blob([csvContent], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `${meter.id}_data.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
function exportJSON(index) {
  const meter = meters[index];
  if (!meter || meter.data.length === 0) return;
  const blob = new Blob([JSON.stringify(meter.data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `${meter.id}_data.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Collapsible dropdown UI handler
document.addEventListener('DOMContentLoaded', function() {
  document.body.addEventListener('click', function(event) {
    if (event.target.classList.contains('collapsible-toggle') || event.target.closest('.collapsible-toggle')) {
      const btn = event.target.closest('.collapsible-toggle');
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', (!expanded).toString());
    }
  });
});

// Expose for inline onclick
window.addMeter = addMeter;
window.startMeter = startMeter;
window.stopMeter = stopMeter;
window.removeMeter = removeMeter;
window.exportCSV = exportCSV;
window.exportJSON = exportJSON;
window.injectFault = injectFault;

// Demo: Add first meter
addMeter();
