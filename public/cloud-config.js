/* 云服务公开配置：由 workbuddy_cloud_service 返回的 publicConfig 原样落地。
   这里只有「可公开」的前端配置（endpoint / publishableKey / oauthRelayBaseUrl），
   环境 ID 与服务商密钥始终留在服务端，不会出现在这个文件里。 */
window.__BOSS_CLOUD__ = {
  appId: 'wbapp_6rSayfvJ29c02PBCoVGvRZ',
  resourceId: 'wbcs_93csXJhzdOzfztes4Mj0d4',
  endpoint: 'https://boss-agent.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_6rSayfvJ29c02PBCoVGvRZ_yMPEkHFRo9DuMY8yog5PdtSmO07WKVD3'
};
