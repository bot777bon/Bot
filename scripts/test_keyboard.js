const path = require('path');
const mod = require(path.resolve(__dirname, '..', 'src', 'i18n'));
const fs = require('fs');
(async ()=>{
  try{
    const { t, tForLang, getAvailableLangs, setUserLang } = mod;
    console.log('Available langs:', getAvailableLangs());
    for (const lang of getAvailableLangs()){
      const uid = 'test_' + lang;
      setUserLang(uid, lang);
      console.log(`\n--- Labels for language: ${lang} ---`);
  const keys = ['main.wallet','main.strategy','main.show_tokens','main.invite_friends','main.sniper','main.sniper_cex','main.language','main_extra.choose_language','common.show_wallet'];
      for (const k of keys) {
        try {
          console.log(k + ' => ' + t(k, uid));
        } catch (e) {
          console.log(k + ' => <error>');
        }
      }
    }
  }catch(e){
    console.error(e);
    process.exit(1);
  }
})();
