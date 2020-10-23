const cookieName = 'Fa米家'
const signurlKey = 'hotkids_signurl_familymart'
const signheaderKey = 'hotkids_signheader_familymart'
const signbodyKey = 'hotkids_signbody_familymart'
const hotkids = init()
const signurlVal = hotkids.getdata(signurlKey)
const signheaderVal = hotkids.getdata(signheaderKey)

sign()

function sign() {

  const url = { url: signurlVal, headers: JSON.parse(signheaderVal)}
  hotkids.get(url, (error, response, data) => {
    const result = JSON.parse(data)
    let subTitle = ``
    let detail = ``
    const code = result.code
    const message = result.message
    const todayRewardNum = result.data['todayRewardNum']
    const resWordDown = result.data['resWordDown']
    const signCount = result.data['signCount']
    if (code == "200") {
      subTitle = `签到结果：成功`
      detail = ` 连续签到天数 ${signCount} 天 `
    } else if (code == "1000") {
      const message = result.message
      subTitle = ` ${message}`
    }
    hotkids.msg(cookieName, subTitle, detail)
    hotkids.done()
  })
}


function init() {
  isSurge = () => {
    return undefined === this.$httpClient ? false : true
  }
  isQuanX = () => {
    return undefined === this.$task ? false : true
  }
  getdata = (key) => {
    if (isSurge()) return $persistentStore.read(key)
    if (isQuanX()) return $prefs.valueForKey(key)
  }
  setdata = (key, val) => {
    if (isSurge()) return $persistentStore.write(key, val)
    if (isQuanX()) return $prefs.setValueForKey(key, val)
  }
  msg = (title, subtitle, body) => {
    if (isSurge()) $notification.post(title, subtitle, body)
    if (isQuanX()) $notify(title, subtitle, body)
  }
  log = (message) => console.log(message)
  get = (url, cb) => {
    if (isSurge()) {
      $httpClient.get(url, cb)
    }
    if (isQuanX()) {
      url.method = 'GET'
      $task.fetch(url).then((resp) => cb(null, resp, resp.body))
    }
  }
  post = (url, cb) => {
    if (isSurge()) {
      $httpClient.post(url, cb)
    }
    if (isQuanX()) {
      url.method = 'POST'
      $task.fetch(url).then((resp) => cb(null, resp, resp.body))
    }
  }
  done = (value = {}) => {
    $done(value)
  }
  return { isSurge, isQuanX, msg, log, getdata, setdata, get, post, done }
}
