// forked from /xOS/Config
// 移除对个人页面会员功能（removeHomeVip）的修改	

const mainConfig={isDebug:true,removeHomeVip:false,removeHomeCreatorTask:true,removeRelate:true,removeGood:true,removeFollow:true,modifyMenus:true,removeRelateItem:true,removeRecommendItem:true,removeRewardItem:true,removeLiveMedia:true,removeNextVideo:true,removePinedTrending:true,removeInterestFriendInTopic:true,removeInterestTopic:true,removeInterestUser:true,removeLvZhou:true,removeSearchWindow:true,removeUnfollowTopic:true,removeUnusedPart:true,blockIds:[2794631974],tabIconVersion:0,tabIconPath:"http://5b0988e595225.cdn.sohucs.com/skin-hebe.zip",}
const itemMenusConfig={creator_task:true,mblog_menus_custom:false,mblog_menus_video_later:true,mblog_menus_comment_manager:false,mblog_menus_avatar_widget:false,mblog_menus_card_bg:false,mblog_menus_long_picture:false,mblog_menus_delete:false,mblog_menus_edit:false,mblog_menus_edit_history:false,mblog_menus_edit_video:false,mblog_menus_sticking:false,mblog_menus_open_reward:true,mblog_menus_novelty:false,mblog_menus_favorite:false,mblog_menus_promote:true,mblog_menus_modify_visible:false,mblog_menus_copy_url:false,mblog_menus_follow:false,mblog_menus_video_feedback:false,mblog_menus_shield:false,mblog_menus_report:false,mblog_menus_apeal:false,mblog_menus_home:false}
function nobyda(){const isQuanX=typeof $task!="undefined";const isSurge=typeof $httpClient!="undefined";const isRequest=typeof $request!="undefined";const notify=(title,subtitle='',message='')=>{if(isQuanX)$notify(title,subtitle,message)
if(isSurge)$notification.post(title,subtitle,message);}
const write=(value,key)=>{if(isQuanX)return $prefs.setValueForKey(value,key);if(isSurge)return $persistentStore.write(value,key);}
const read=(key)=>{if(isQuanX)return $prefs.valueForKey(key);if(isSurge)return $persistentStore.read(key);}
const done=(value={})=>{if(isQuanX)return $done(value);if(isSurge)isRequest?$done(value):$done();}
return{isRequest,isSurge,isQuanX,notify,write,read,done}}
let $=new nobyda();$.write(JSON.stringify(mainConfig),'mainConfig');$.write(JSON.stringify(itemMenusConfig),'itemMenusConfig');console.log($.read('isDebug'));console.log($.read('mainConfig'));console.log($.read('itemMenusConfig'));console.log('success');$.notify('微博自定义配置更改成功');$.done();
