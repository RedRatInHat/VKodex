const config = globalThis.VKODEX_CANARY_CONFIG;
const status = document.getElementById("status"), arm = document.getElementById("arm");
document.getElementById("target").textContent = config.pageUrl;
document.getElementById("expected").textContent = config.expectedText;
async function request(type) {
  arm.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) throw new Error(response?.error || "Нет подтверждённого результата");
    status.textContent = JSON.stringify(response.state, null, 2);
    arm.disabled = response.state.phase !== "idle";
  } catch (error) { status.textContent = String(error.message || error); }
}
arm.addEventListener("click", () => void request("arm"));
document.getElementById("refresh").addEventListener("click", () => void request("status"));
document.getElementById("stop").addEventListener("click", () => void request("stop"));
void request("status");
