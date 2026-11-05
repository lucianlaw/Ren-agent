/* 员工排序：核心置顶 → 按名字首字母 A→Z（中文取拼音首字母，英文取原字母）
 *
 * 为什么不内嵌拼音字典：浏览器自带的拼音排序（Intl.Collator('zh-u-co-pinyin')）
 * 已经把汉字按拼音排好，我们只要判断一个字落在哪个字母区间——用 23 个边界字
 * 二分即可，零数据。少数汉字在 ICU 里会被排到「同音但笔画少」的位置
 * （例如 七 排在「啪」之前、夕 排在「挖」之前），用一张 116 字的修正表拉回。
 * 整份数据不到 300 字，不联网、不需要任何外部资源。
 */
(function () {
  var LETTERS = 'abcdefghjklmnopqrstwxyz';   /* 拼音没有 i / u / v 开头 */
  var BOUND   = '阿八擦搭蛾发噶哈击喀拉妈拿哦啪期然撒塌挖昔压匝';
  var FIX     = '七q丌j丫y丷b乼z亇g他t仨s伬c佦y倛q兮x凄q劸w匙c卥x吸x呚q呥r咑d咔k咖k哒d嗒d嘎g嘠g噷x嚓c圧y垃l夕x她t妑p妻q娸q它t尜g屲w巬g巭g帀z希x徔c忚x恷q悽q戚q扱x扸x拏n挱s挲s捿q攲q旮g柒q栖q桤q桲b桼q橵z橺x櫵q氞n汐x沏q淒q煀q煷h燝z爠q牠t瓲t皅p硘h祂t穵w笚d笹s篒y紦h緕z繌z繧w耷d肰r脦t舥p荅d萋q蚦r蚺r螁t螩d衻r袇r袡r裄h西x覀x讥j趴p趿t迉q邜x郪q釓g鉄t錻b鎆j鏱j钆g铊t餎g饹g鵤z';

  var coll = null;
  function cmp(a, b) {
    if (!coll) {
      try { coll = new Intl.Collator('zh-Hans-CN-u-co-pinyin'); }
      catch (e) { coll = new Intl.Collator(); }
    }
    return coll.compare(a, b);
  }

  var fixMap = null;
  function fixes() {
    if (fixMap) return fixMap;
    fixMap = Object.create(null);
    var arr = Array.from(FIX);
    for (var i = 0; i + 1 < arr.length; i += 2) fixMap[arr[i]] = arr[i + 1];
    return fixMap;
  }

  function isHan(ch) {
    var c = ch.codePointAt(0);
    return (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x4E00 && c <= 0x9FFF) ||
           (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x20000 && c <= 0x3FFFF);
  }

  /* 一个汉字的拼音首字母；查不出来返回 '' */
  function hanInitial(ch) {
    var cp = ch.codePointAt(0);
    /* 基本区以外（扩展 A/B、兼容字）ICU 排不准，宁可当未知，也别硬塞进某个字母 */
    if (cp < 0x4E00 || cp > 0x9FA5) return '';
    var f = fixes()[ch];
    if (f) return f;

    var lo = 0, hi = BOUND.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cmp(BOUND[mid], ch) <= 0) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans < 0 ? '' : LETTERS.charAt(ans);
  }

  /* 名字的排序字母：中文取首字拼音，英文取首个字母 */
  function initialOf(name) {
    var arr = Array.from(String(name || '').trim());
    if (!arr.length) return '';
    var ch = arr[0];
    if (isHan(ch)) return hanInitial(ch);
    var m = /[a-z]/i.exec(ch);
    return m ? m[0].toLowerCase() : '';
  }

  /* 排序键：字母为空的排在本组最后 */
  function keyOf(name) {
    var k = initialOf(name);
    return k || '\u{10FFFF}';
  }

  /* 两个名字怎么排：先比首字母，同字母再按拼音（内置排序）细排 */
  function cmpName(a, b) {
    a = String(a == null ? '' : a);
    b = String(b == null ? '' : b);
    var ka = keyOf(a), kb = keyOf(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return cmp(a, b);
  }

  /* 员工排序：核心置顶，其余按首字母 */
  function cmpStaff(a, b) {
    var ca = a && a.core ? 1 : 0, cb = b && b.core ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return cmpName(a && a.name, b && b.name);
  }

  /* 不改原数组 */
  function sortStaff(list) {
    return (list || []).slice().sort(cmpStaff);
  }

  window.NAMEORDER = {
    initialOf: initialOf,
    cmpName: cmpName,
    cmpStaff: cmpStaff,
    sortStaff: sortStaff,
    isHan: isHan
  };
})();
