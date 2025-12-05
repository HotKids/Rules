const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.61 Safari/537.36",
  "Accept-Language": "en"
};

const STATUS_COMING = 2;
const STATUS_AVAILABLE = 1;
const STATUS_NOT_AVAILABLE = 0;
const STATUS_TIMEOUT = -1;
const STATUS_ERROR = -2;

const UA = REQUEST_HEADERS["User-Agent"];

function buildLine(region2, name) {
  return `${name.padEnd(9, " ")} ➟ ${region2 || "N/A"}`;
}

function buildYesLine(status, name) {
  return `${name.padEnd(9, " ")} ➟ ${status === "good" ? "YES" : "N/A"}`;
}

;(async () => {
  let panel_result = { title: "可用性检测", content: "", icon: "play.circle.fill" };

  const netflix_raw = await check_netflix();
  const disney_res = await testDisneyPlus();
  const youtube_raw = await check_youtube_premium();
  const spotify_res = await checkSpotify();
  const chatgpt_res = await checkChatGPT();
  const claude_res = await checkClaude();

  let nfStatus = "bad", nfRegion2 = "US";
  if (typeof netflix_raw === "string") {
    const m = netflix_raw.match(/➟\s*([A-Z]{2})/);
    if (m) nfRegion2 = m[1];
    if (netflix_raw.includes("已解锁")) nfStatus = "good";
  }

  let dyStatus = "bad", dyRegion2 = disney_res?.region || "US";
  if (disney_res?.status === STATUS_AVAILABLE) dyStatus = "good";

  let ytStatus = "bad", ytRegion2 = "US";
  if (typeof youtube_raw === "string") {
    const m = youtube_raw.match(/➟\s*([A-Z]{2})/);
    if (m) ytRegion2 = m[1];
    if (youtube_raw.includes("已解锁")) ytStatus = "good";
  }

  let spStatus = spotify_res?.status || "bad";
  let spRegion2 = spotify_res?.region || "N/A";

  let cgStatus = chatgpt_res === "good" ? "good" : "bad";
  let clStatus = claude_res === "good" ? "good" : "bad";

  const lines = [
    buildLine(nfRegion2, "Netflix"),
    buildLine(dyRegion2, "Disney+"),
    buildLine(ytRegion2, "YouTube"),
    buildLine(spRegion2, "Spotify"),
    buildLine("SG", "ChatGPT"),
    buildYesLine(clStatus, "Claude")
  ];

  const statuses = [nfStatus, dyStatus, ytStatus, spStatus, cgStatus, clStatus];
  const goodCount = statuses.filter(s => s === "good").length;
  const hasBad = statuses.includes("bad");

  let titleIcon = hasBad ? "🟡" : "🟢";
  let iconColor = hasBad ? "#DAA520" : "#3CB371";
  panel_result.title = `${titleIcon} 可用性检测 ${goodCount}/6`;
  panel_result["icon-color"] = iconColor;

  panel_result.content = lines.join("\n");
  $done(panel_result);
})();

async function check_youtube_premium() {
  return new Promise((resolve) => {
    $httpClient.get({ url: "https://www.youtube.com/premium", headers: REQUEST_HEADERS }, function (error, response, data) {
      if (error || response.status !== 200) return resolve("YouTube未解锁");
      if (data.includes("Premium is not available in your country")) return resolve("YouTube未解锁");
      const m = data.match(/"countryCode":"(.*?)"/);
      resolve("YouTube已解锁 ➟ " + (m ? m[1] : "US"));
    });
  });
}

async function check_netflix() {
  const inner = (id) => new Promise((res, rej) => {
    $httpClient.get({ url: "https://www.netflix.com/title/" + id, headers: REQUEST_HEADERS }, (e, r) => {
      if (e || r.status === 403) return rej();
      if (r.status === 404) return res("NF");
      if (r.status === 200) {
        let u = r.headers["x-originating-url"];
        let c = u ? u.split("/")[3].split("-")[0] : "us";
        res(c.toUpperCase());
      }
    });
  });

  try {
    const c = await inner(80062035);
    if (c !== "NF") return "Netflix已解锁 ➟ " + c;
    const c2 = await inner(80018499);
    return "Netflix已解锁 ➟ " + c2;
  } catch {
    return "Netflix未解锁";
  }
}

async function testDisneyPlus() {
  try {
    let { region, cnbl } = await Promise.race([
      testHomePage(),
      timeout(7000)
    ]);

    let { countryCode, inSupportedLocation } = await Promise.race([
      getLocationInfo(),
      timeout(7000)
    ]);

    region = countryCode ?? region;

    if (inSupportedLocation === false || inSupportedLocation === "false") {
      return { region, status: STATUS_COMING };
    } else {
      return { region, status: STATUS_AVAILABLE };
    }
  } catch (error) {
    if (error === "Not Available") {
      return { status: STATUS_NOT_AVAILABLE };
    }
    if (error === "Timeout") {
      return { status: STATUS_TIMEOUT };
    }
    return { status: STATUS_ERROR };
  }
}

function getLocationInfo() {
  return new Promise((resolve, reject) => {
    let opts = {
      url: "https://disney.api.edge.bamgrid.com/graph/v1/device/graphql",
      headers: {
        "Accept-Language": "en",
        Authorization:
          "ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84",
        "Content-Type": "application/json",
        "User-Agent": UA
      },
      body: JSON.stringify({
        query:
          "mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }",
        variables: {
          input: {
            applicationRuntime: "chrome",
            attributes: {
              browserName: "chrome",
              browserVersion: "94.0.4606",
              manufacturer: "apple",
              model: null,
              operatingSystem: "macintosh",
              operatingSystemVersion: "10.15.7",
              osDeviceIds: []
            },
            deviceFamily: "browser",
            deviceLanguage: "en",
            deviceProfile: "macosx"
          }
        }
      })
    };
    $httpClient.post(opts, function (error, response, data) {
      if (error) {
        reject("Error");
        return;
      }
      if (response.status !== 200) {
        reject("Not Available");
        return;
      }
      data = JSON.parse(data);
      if (data?.errors) {
        reject("Not Available");
        return;
      }
      let {
        token: { accessToken },
        session: {
          inSupportedLocation,
          location: { countryCode }
        }
      } = data?.extensions?.sdk;
      resolve({ inSupportedLocation, countryCode, accessToken });
    });
  });
}

function testHomePage() {
  return new Promise((resolve, reject) => {
    let opts = {
      url: "https://www.disneyplus.com/",
      headers: {
        "Accept-Language": "en",
        "User-Agent": UA
      }
    };
    $httpClient.get(opts, function (error, response, data) {
      if (error) {
        reject("Error");
        return;
      }
      if (
        response.status !== 200 ||
        data.indexOf("Sorry, Disney+ is not available in your region.") !== -1
      ) {
        reject("Not Available");
        return;
      }
      let match = data.match(/Region: ([A-Za-z]{2})[\s\S]*?CNBL: ([12])/);
      if (!match) {
        resolve({ region: "", cnbl: "" });
        return;
      }
      let region = match[1];
      let cnbl = match[2];
      resolve({ region, cnbl });
    });
  });
}

function timeout(delay = 5000) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      reject("Timeout");
    }, delay);
  });
}

async function checkSpotify() {
  try {
    const r = await timeoutFetch("https://www.spotify.com/premium/");
    const m = r.match(/spotify\.com\/([a-z]{2})\//);
    return { status: "good", region: m ? m[1].toUpperCase() : "US" };
  } catch {
    return { status: "bad", region: "N/A" };
  }
}

async function checkChatGPT() {
  const r = await timeoutRaw("https://chat.openai.com/cdn-cgi/trace");
  if (r && r.includes("loc=")) return "good";
  return "bad";
}

async function checkClaude() {
  const r = await timeoutRaw("https://claude.ai");
  if (r && r.includes("app-unavailable-in-region")) return "bad";
  return r ? "good" : "bad";
}

function timeoutFetch(url, t = 3000) {
  return new Promise((resolve, reject) => {
    let done = false;
    setTimeout(() => !done && reject(), t);
    $httpClient.get({ url, headers: REQUEST_HEADERS }, (e, r, d) => {
      if (done) return;
      done = true;
      e || !d ? reject() : resolve(d);
    });
  });
}

function timeoutRaw(url, t = 3000) {
  return new Promise((resolve) => {
    let done = false;
    setTimeout(() => !done && resolve(null), t);
    $httpClient.get({ url, headers: REQUEST_HEADERS }, (e, r, d) => {
      if (done) return;
      done = true;
      resolve(d || null);
    });
  });
}
