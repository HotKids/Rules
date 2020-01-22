const path1 = "/x/resource/show/tab?access_key";
const path2 = "/x/v2/feed/index?access_key";
const path3 = "/x/v2/account/mine?access_key";
const path4 = "/x/v2/view?access_key";
const path5 = "/x/v2/view/material?access_key";
const path6 = "/x/v2/reply/main?access_key";
const path7 = "/x/v2/rank?access_key";
const path8 = "/x/v2/show/popular/index";
const path9 = "/xlive/app-room/v1/index/getInfoByRoom?access_key";

let url = $request.url;
let body = JSON.parse($response.body);

if (url.indexOf(path1) != -1) {
  //Customize whitelist
  let whitelist = ['直播', '推荐', '追番'];
  body['data']['tab'].forEach((element, index) => {
    if (!(whitelist.includes(element['name']))) {
      body['data']['tab'].splice(index, 1);
    }
  })
  body['data']['bottom'].forEach((element, index) => {
    if (element['pos'] == 4) {
      body['data']['bottom'].splice(index, 1);
    }
  })
  delete body['data']['top'];
}

if (url.indexOf(path2) != -1) {
  let blacklist = [];
  body['data']['items'].forEach((element, index) => {
    if (element.hasOwnProperty('ad_info') || element.hasOwnProperty('banner_item') || element['card_type'] != 'small_cover_v2' || blacklist.includes(element['args']['up_name'])) {
      body['data']['items'].splice(index, 1);
    }
  })
}

if (url.indexOf(path3) != -1) {
  body['data']['sections'].splice(0, 1);
  body['data']['sections'][0]['items'].splice(3, 1);
  body['data']['sections'][0]['items'].splice(4, 3);
  body['data']['sections'].splice(1, 1);
}

if (url.indexOf(path4) != -1) {
  if (body['data'].hasOwnProperty('relates')) {
    body['data']['relates'].forEach((element, index) => {
      if (element.hasOwnProperty('is_ad') || !element.hasOwnProperty('aid')) {
        body['data']['relates'].splice(index, 1);
      }
    })
    delete body['data']['cms'];
  }
}

if (url.indexOf(path5) != -1) {
  body.data = null;
}

if (url.indexOf(path6) != -1) {
  if (body.hasOwnProperty('data')) {
    delete body['data']['notice'];
  }
}

if (url.indexOf(path7) != -1) {
  //Customize blacklist
  let blacklist = [];
  body['data'].forEach((element, index) => {
    if (blacklist.includes(element['name'])) {
      body['data'].splice(index, 1);
    }
  })
}

if (url.indexOf(path8) != -1) {
  //Customize blacklist
  let blacklist = [];
  body['data'].forEach((element, index) => {
    if (blacklist.includes(element['right_desc_1']) || element["card_type"] !== "small_cover_v5") {
      body['data'].splice(index, 1);
    }
  })
}

if (url.indexOf(path9) != -1) {
  body['data']['activity_banner_info'] = null;
}

$done({
  body: JSON.stringify(body)
});
