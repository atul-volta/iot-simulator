let meters = [];
let meterCount = 0;
let flowCharts = {};
let totalCharts = {};
let mqttClients = {}; // meter.id -> mqtt.js client

let openDetails = {};      // MQTT settings
let openProbDetails = {};  // Probability/fault settings

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
    mqttStatus: "",
    probLeak: 2,
    probBurst: 1,
    probReverse: 0.5,
    probOffline: 0.5,
    injectStatus: "",
    injectPending: false,
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
  generateMeterData(meter);
  meter.timer = setInterval(() => {
    generateMeterData(meter);
    renderMeters(false);
  }, meter.interval * 1000);
  renderMeters();
}

function stopMeter(index) {
  clearInterval(meters[index].timer);
  meters[index].timer = null;
  renderMeters();
}

function generateMeterData(meter) {
  let flowRate = getFlowRate(meter.profile);
  let rowStatus = "normal";

  // ---- Fault Injection ----
  if (meter.injectPending && meter.injectStatus && meter.injectStatus !== "normal") {
    rowStatus = meter.injectStatus;
    meter.injectPending = false; // Clear after one use
    flowRate = anomalyFlow(rowStatus, flowRate); // Apply flow anomaly
  } else {
    // ---- Randomly apply fault/anomaly based on probabilities ----
    const r = Math.random() * 100;
    if (r < meter.probBurst) {
      rowStatus = "burst";
      flowRate = anomalyFlow("burst", flowRate);
    } else if (r < meter.probBurst + meter.probLeak) {
      rowStatus = "leak";
      flowRate = anomalyFlow("leak", flowRate);
    } else if (r < meter.probBurst + meter.probLeak + meter.probReverse) {
      rowStatus = "reverse flow";
      flowRate = anomalyFlow("reverse flow", flowRate);
    } else if (r < meter.probBurst + meter.probLeak + meter.probReverse + meter.probOffline) {
      rowStatus = "offline";
      flowRate = 0;
    } else if (flowRate < 0.5 && flowRate > 0) {
      rowStatus = "low flow";
    }
  }

  if (rowStatus !== "reverse flow" && flowRate < 0) flowRate = 0;
  if (rowStatus !== "offline") {
    meter.totalVolume += (flowRate * meter.interval) / 60;
  }

  const now = new Date();
  const label = now.toLocaleTimeString();
  meter.data.unshift({
    time: label,
    flow: flowRate,
    total: meter.totalVolume.toFixed(2),
    status: rowStatus
  });

  if (meter.chartLabels.length >= 30) {
    meter.chartLabels.pop();
    meter.flowPoints.pop();
    meter.totalPoints.pop();
  }
  meter.chartLabels.unshift(label);
  meter.flowPoints.unshift(flowRate);
  meter.totalPoints.unshift(meter.totalVolume);

  updateCharts(meter);

  // --- MQTT Export (if enabled) ---
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
    // Build and send message
    const msg = {
      meter_id: meter.id,
      timestamp: new Date().toISOString(),
      flow_rate_lpm: flowRate,
      total_volume_l: meter.totalVolume,
      status: rowStatus
    };
    try {
      mqttClients[meter.id].publish(meter.mqttTopic, JSON.stringify(msg));
      updateMqttStatus(meter.id, "Published");
    } catch (e) {
      updateMqttStatus(meter.id, "Publish Error");
    }
  } else {
    updateMqttStatus(meter.id, "");
  }
}

function anomalyFlow(status, baseFlow) {
  switch (status) {
    case "burst":
      return 20 + Math.random() * 10;
    case "leak":
      return 10 + Math.random() * 5;
    case "reverse flow":
      return -(2 + Math.random() * 3);
    default:
      return baseFlow;
  }
}

function getFlowRate(profile) {
  const hour = new Date().getHours();
  if (profile === "residential") {
    if ((hour >= 6 && hour <= 8) || (hour >= 18 && hour <= 21))
      return Math.random() * 10 + 5;
    if (hour >= 22 || hour <= 5)
      return Math.random() < 0.8 ? 0 : Math.random() * 2;
    return Math.random() * 3;
  } else {
    if (hour >= 8 && hour <= 18)
      return Math.random() * 8 + 3;
    return Math.random() < 0.9 ? 0 : Math.random() * 2;
  }
}

function renderMeters(drawCharts = true) {
  const metersDiv = document.getElementById("meters");

  // --- Preserve open states for <details> sections ---
  openDetails = {};
  openProbDetails = {};
  meters.forEach(meter => {
    const d1 = document.getElementById("mqtt-details-" + meter.id);
    openDetails[meter.id] = d1 ? d1.open : false;
    const d2 = document.getElementById("prob-details-" + meter.id);
    openProbDetails[meter.id] = d2 ? d2.open : false;
  });

  metersDiv.innerHTML = "";
  meters.forEach((meter, idx) => {
    const meterDiv = document.createElement("div");
    meterDiv.className = "meter-card";
    meterDiv.innerHTML = `
      <div class="meter-row">
        <strong>Meter ID:</strong> <input value="${meter.id}" onchange="meters[${idx}].id=this.value">
        <label>Profile:
          <select onchange="meters[${idx}].profile=this.value">
            <option value="residential" ${meter.profile==="residential"?"selected":""}>Residential</option>
            <option value="commercial" ${meter.profile==="commercial"?"selected":""}>Commercial</option>
          </select>
        </label>
        <label>Interval (sec):
          <input type="number" min="1" value="${meter.interval}" onchange="meters[${idx}].interval=parseInt(this.value,10)">
        </label>
        <button onclick="startMeter(${idx})" ${meter.timer ? "disabled" : ""}>Start</button>
        <button onclick="stopMeter(${idx})" ${meter.timer ? "" : "disabled"}>Stop</button>
        <button onclick="removeMeter(${idx})">Remove</button>
      </div>
      <div class="section-divider"></div>
      <div class="meter-row">
        <details id="mqtt-details-${meter.id}" ${openDetails[meter.id] ? "open" : ""} style="margin-bottom: 0.7em;">
          <summary><b>MQTT Settings</b> (optional)</summary>
          <div class="details-content">
            <label>Broker URL:
              <input type="text" value="${meter.mqttBroker}" onchange="meters[${idx}].mqttBroker=this.value">
            </label>
            <label>Topic:
              <input type="text" value="${meter.mqttTopic}" onchange="meters[${idx}].mqttTopic=this.value">
            </label>
            <label>
              <input type="checkbox" ${meter.mqttEnabled ? "checked" : ""} onchange="meters[${idx}].mqttEnabled=this.checked">
              Enable MQTT Export
            </label>
            <span id="mqttStatus-${meter.id}" class="mqtt-status">${meter.mqttStatus || ""}</span>
          </div>
        </details>
        <details id="prob-details-${meter.id}" ${openProbDetails[meter.id] ? "open" : ""}>
          <summary><b>Status Anomaly Probabilities & Fault Injection</b></summary>
          <div class="details-content flex-wrap">
            <div class="prob-row">
              <label>Leak (%):
                <input type="number" min="0" max="100" value="${meter.probLeak}" style="width: 55px"
                  onchange="meters[${idx}].probLeak=parseFloat(this.value)">
              </label>
              <label>Burst (%):
                <input type="number" min="0" max="100" value="${meter.probBurst}" style="width: 55px"
                  onchange="meters[${idx}].probBurst=parseFloat(this.value)">
              </label>
              <label>Reverse Flow (%):
                <input type="number" min="0" max="100" value="${meter.probReverse}" style="width: 55px"
                  onchange="meters[${idx}].probReverse=parseFloat(this.value)">
              </label>
              <label>Offline (%):
                <input type="number" min="0" max="100" value="${meter.probOffline}" style="width: 55px"
                  onchange="meters[${idx}].probOffline=parseFloat(this.value)">
              </label>
            </div>
            <div class="inject-row">
              <label>Inject Fault:
                <select id="inject-${meter.id}">
                  <option value="">-- select --</option>
                  <option value="leak">Leak</option>
                  <option value="burst">Burst</option>
                  <option value="reverse flow">Reverse Flow</option>
                  <option value="offline">Offline</option>
                  <option value="low flow">Low Flow</option>
                </select>
                <button onclick="injectFault(${idx})">Inject</button>
              </label>
              <span style="color:#ba8008; font-size:0.98em;">(injects for next reading)</span>
            </div>
          </div>
        </details>
      </div>
      <div class="export-btns">
        <button onclick="exportCSV(${idx})">Export CSV</button>
        <button onclick="exportJSON(${idx})">Export JSON</button>
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

  if (drawCharts) {
    setTimeout(() => {
      meters.forEach((meter, idx) => {
        drawOrUpdateChart(meter);
      });
    }, 10);
  }
}

function injectFault(idx) {
  const meter = meters[idx];
  const val = document.getElementById(`inject-${meter.id}`).value;
  if (val) {
    meter.injectStatus = val;
    meter.injectPending = true;
  }
}

function updateMqttStatus(meterId, msg) {
  const meter = meters.find(m => m.id === meterId);
  if (meter) {
    meter.mqttStatus = msg;
    if (msg === "Published") {
      setTimeout(() => {
        if (meter.mqttStatus === "Published") {
          meter.mqttStatus = "Connected";
          const el = document.getElementById("mqttStatus-" + meterId);
          if (el) el.textContent = "Connected";
        }
      }, 1200);
    }
  }
  const el = document.getElementById("mqttStatus-" + meterId);
  if (el) el.textContent = msg;
}

function updateCharts(meter) {
  renderMeters();
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
