// Headless test runner: laedt die Pipeline-Logik aus index.html und testet sie
// gegen synthetische Fixtures, ohne Browser.

const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

// === Helpers from index.html ===
function slug(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}

function parseXML(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
  const nsW = 'http://wordpress.org/export/1.2/', nsC = 'http://purl.org/rss/1.0/modules/content/',
        nsD = 'http://purl.org/dc/elements/1.1/', nsE = 'http://wordpress.org/export/1.2/excerpt/';
  const g = (p, t, ns) => { const el = ns ? p.getElementsByTagNameNS(ns, t)[0] : p.getElementsByTagName(t)[0]; return el ? el.textContent : ''; };

  const terms = [];
  for (const t of doc.getElementsByTagNameNS(nsW, 'term')) {
    terms.push({
      termId: g(t,'term_id',nsW),
      taxonomy: g(t,'term_taxonomy',nsW),
      slug: g(t,'term_slug',nsW),
      name: g(t,'term_name',nsW),
      parentSlug: g(t,'term_parent',nsW),
    });
  }
  for (const c of doc.getElementsByTagNameNS(nsW, 'category')) {
    terms.push({
      termId: g(c,'term_id',nsW),
      taxonomy: 'category',
      slug: g(c,'category_nicename',nsW),
      name: g(c,'cat_name',nsW),
      parentSlug: g(c,'category_parent',nsW),
    });
  }

  const items = [];
  for (const it of Array.from(doc.getElementsByTagName('item'))) {
    const meta = {};
    for (const m of Array.from(it.getElementsByTagNameNS(nsW, 'postmeta'))) {
      const k = g(m,'meta_key',nsW), v = g(m,'meta_value',nsW);
      if (k) meta[k] = v;
    }
    const taxonomies = [];
    for (const c of Array.from(it.getElementsByTagName('category'))) {
      taxonomies.push({ taxonomy: c.getAttribute('domain')||'category', slug: c.getAttribute('nicename')||'', term: c.textContent });
    }
    items.push({
      postId: g(it,'post_id',nsW), postType: g(it,'post_type',nsW),
      title: g(it,'title',null), content: g(it,'encoded',nsC),
      excerpt: g(it,'encoded',nsE), slug: g(it,'post_name',nsW),
      date: g(it,'post_date',nsW), dateGmt: g(it,'post_date_gmt',nsW),
      modified: g(it,'post_modified',nsW), status: g(it,'status',nsW),
      postParent: g(it,'post_parent',nsW), menuOrder: g(it,'menu_order',nsW),
      creator: g(it,'creator',nsD), meta, taxonomies,
    });
  }
  items._terms = terms;
  return items;
}

// === Pipeline (mirrored from index.html) ===
function runPipeline(ST) {
  const mappings = ST.mappings;
  const allItems = [];
  const byId = {};
  for (const [idx, fd] of Object.entries(ST.files)) {
    for (const item of fd.items) {
      const it = { ...item, _fi: idx };
      allItems.push(it);
      byId[String(item.postId)] = it;
    }
  }

  const ptMaps = mappings.filter(m => m.tgt.type === 'post_type');
  const catMap = mappings.find(m => m.tgt.name === 'child_category');
  const joinMap = mappings.find(m => m.tgt.name === 'section_join');
  const extractMap = mappings.find(m => m.tgt.name === 'extract_chained_quiz');

  const cats = [];
  let catId = 100001;

  let parentCat = null;
  if (catMap) {
    const pName = ST.parentCatName || 'Etappen';
    parentCat = { termId: catId++, name: pName, slug: slug(pName), parentSlug: '' };
    cats.push(parentCat);
  }

  if (catMap) {
    const src = catMap.src;
    if (src.type === 'post_type') {
      const items = allItems.filter(i => i.postType === src.name);
      for (const it of items) {
        cats.push({ termId: catId++, name: it.title, slug: it.slug || slug(it.title), parentSlug: parentCat?.slug || '', _srcId: String(it.postId) });
      }
    } else if (src.type === 'taxonomy') {
      const seen = new Set();
      for (const it of allItems) {
        for (const tx of it.taxonomies) {
          if (tx.taxonomy === src.name && !seen.has(tx.slug)) {
            seen.add(tx.slug);
            cats.push({ termId: catId++, name: tx.term, slug: tx.slug, parentSlug: parentCat?.slug || '', _taxSlug: tx.slug });
          }
        }
      }
    }
  }

  const secIdToCat = {};
  const taxSlugToCat = {};
  const slugToCat = {};
  const nameToCat = {};
  const termIdToCat = {};
  for (const c of cats) {
    if (c._srcId) secIdToCat[String(c._srcId)] = c;
    if (c._taxSlug) taxSlugToCat[c._taxSlug] = c;
    if (c.slug && c.parentSlug) { slugToCat[c.slug] = c; nameToCat[c.name] = c; }
  }
  const termIdToSlug = {};
  for (const fd of Object.values(ST.files)) {
    const ts = fd.items?._terms || [];
    for (const t of ts) {
      if (t.termId && t.slug) termIdToSlug[String(t.termId)] = t.slug;
      if (t.termId && taxSlugToCat[t.slug]) termIdToCat[String(t.termId)] = taxSlugToCat[t.slug];
    }
  }

  const posts = [];
  let pid = 200001;

  for (const ptm of ptMaps) {
    const srcPT = ptm.src.name;
    const tgtPT = ptm.tgt.name;
    const srcItems = allItems.filter(i => i.postType === srcPT);

    for (const item of srcItems) {
      const post = {
        postId: pid++,
        title: item.title,
        content: item.content || '',
        slug: item.slug || slug(item.title),
        date: item.date, dateGmt: item.dateGmt, modified: item.modified,
        status: item.status || 'publish',
        postType: tgtPT,
        menuOrder: parseInt(item.menuOrder, 10) || 0,
        meta: {},
        categories: [],
        _srcId: item.postId,
        _srcPT: srcPT,
      };

      for (const mm of mappings) {
        if (mm.src.type !== 'meta') continue;
        if (mm.src.postType && mm.src.postType !== srcPT) continue;
        const val = item.meta[mm.src.name];
        if (val === undefined) continue;

        if (mm.tgt.type === 'meta') {
          post.meta[mm.tgt.name] = val;
        } else if (mm.tgt.type === 'field') {
          if (mm.tgt.name === 'menu_order') post.menuOrder = parseInt(val, 10) || 0;
          else if (mm.tgt.name === 'title') post.title = val;
          else if (mm.tgt.name === 'slug') post.slug = val;
        }
      }

      if (extractMap) {
        const m = post.content.match(/\[chained-quiz\s+\d+\]/);
        if (m) {
          post.meta.wg_besenwagen_code = m[0];
          post.content = post.content.replace(/\[chained-quiz[^\]]*\]/g, '').trim();
        }
      }

      if (joinMap && joinMap.src.type === 'meta') {
        const secId = String(item.meta[joinMap.src.name] || '');
        if (secId) {
          let mc = secIdToCat[secId];
          if (!mc) {
            const secItem = byId[secId];
            if (secItem) {
              mc = slugToCat[secItem.slug] || nameToCat[secItem.title];
              if (!mc) {
                for (const tx of secItem.taxonomies) {
                  mc = taxSlugToCat[tx.slug];
                  if (mc) break;
                }
              }
              if (!mc && secItem.title) {
                const newCat = { termId: catId++, name: secItem.title, slug: secItem.slug || slug(secItem.title), parentSlug: parentCat?.slug || '', _srcId: String(secItem.postId) };
                cats.push(newCat);
                secIdToCat[String(secItem.postId)] = newCat;
                slugToCat[newCat.slug] = newCat;
                nameToCat[newCat.name] = newCat;
                mc = newCat;
              }
            }
          }
          if (!mc) mc = termIdToCat[secId];
          if (!mc && termIdToSlug[secId]) mc = taxSlugToCat[termIdToSlug[secId]];
          if (!mc) {
            for (const tx of item.taxonomies) {
              mc = taxSlugToCat[tx.slug] || slugToCat[tx.slug] || nameToCat[tx.term];
              if (mc) break;
            }
          }
          if (mc) {
            post.categories.push({ name: mc.name, slug: mc.slug });
            if (mc.parentSlug && parentCat) {
              post.categories.push({ name: parentCat.name, slug: parentCat.slug });
            }
          } else {
            post._unresolved = secId;
          }
        } else {
          for (const tx of item.taxonomies) {
            const mc = taxSlugToCat[tx.slug] || slugToCat[tx.slug] || nameToCat[tx.term];
            if (mc) {
              post.categories.push({ name: mc.name, slug: mc.slug });
              if (mc.parentSlug && parentCat) {
                post.categories.push({ name: parentCat.name, slug: parentCat.slug });
              }
              break;
            }
          }
        }
      } else {
        for (const tx of item.taxonomies) {
          const mc = taxSlugToCat[tx.slug] || slugToCat[tx.slug] || nameToCat[tx.term];
          if (mc && !post.categories.some(c => c.slug === mc.slug)) {
            post.categories.push({ name: mc.name, slug: mc.slug });
            if (mc.parentSlug && parentCat) {
              post.categories.push({ name: parentCat.name, slug: parentCat.slug });
            }
          }
        }
      }

      for (const tx of item.taxonomies) {
        if (tx.taxonomy === 'category' && !post.categories.some(c => c.slug === tx.slug)) {
          post.categories.push({ name: tx.term, slug: tx.slug });
        }
      }

      for (const [k, v] of Object.entries(item.meta)) {
        if (!k.startsWith('_') && v != null && v !== '' && !post.meta[k]) {
          post.meta[k] = v;
        }
      }

      posts.push(post);
    }
  }

  // Auto-dedupe slugs
  const postSlugUsed = {};
  let dupePostsFixed = 0;
  for (const p of posts) {
    const k = p.postType + ':' + p.slug;
    if (postSlugUsed[k]) {
      let n = 2;
      while (postSlugUsed[p.postType + ':' + p.slug + '-' + n]) n++;
      p.slug = p.slug + '-' + n;
      postSlugUsed[p.postType + ':' + p.slug] = true;
      dupePostsFixed++;
    } else {
      postSlugUsed[k] = true;
    }
  }
  const catSlugUsed = {};
  let dupeCatsFixed = 0;
  for (const c of cats) {
    if (catSlugUsed[c.slug]) {
      let n = 2;
      while (catSlugUsed[c.slug + '-' + n]) n++;
      c.slug = c.slug + '-' + n;
      catSlugUsed[c.slug] = true;
      dupeCatsFixed++;
    } else {
      catSlugUsed[c.slug] = true;
    }
  }

  return { posts, cats, dupePostsFixed, dupeCatsFixed };
}

function validate(result, ST) {
  const { posts, cats } = result;
  const ptMaps = ST.mappings.filter(m => m.tgt.type === 'post_type');
  const errs = [];
  const lessonPosts = posts.filter(p => ptMaps.some(m => m.tgt.name === 'post' && m.src.name === p._srcPT));
  const unres = lessonPosts.filter(p => p._unresolved);
  if (unres.length) errs.push({ sev: 'fail', msg: unres.length + ' Lektionen ohne aufgeloeste Sektion', det: [...new Set(unres.map(p => p._unresolved))].join(',') });
  const noCat = lessonPosts.filter(p => p.categories.length === 0);
  if (noCat.length) errs.push({ sev: 'fail', msg: noCat.length + ' Lektionen ohne Kategorie' });
  const stillHasQuiz = posts.filter(p => /\[chained-quiz\s+\d+\]/.test(p.content));
  if (stillHasQuiz.length) errs.push({ sev: 'fail', msg: stillHasQuiz.length + ' Posts haben noch [chained-quiz] im Inhalt' });
  return { errs, lessonPosts: lessonPosts.length, assigned: lessonPosts.length - noCat.length };
}

// === RUN TEST ===
const fixDir = path.join(__dirname, 'fixtures');
const lessonsXml = fs.readFileSync(path.join(fixDir, 'Lessons.xml'), 'utf-8');
const sectionsXml = fs.readFileSync(path.join(fixDir, 'Sections.xml'), 'utf-8');
const productsXml = fs.readFileSync(path.join(fixDir, 'Online-Angebote.xml'), 'utf-8');

const ST = {
  files: {
    0: { name: 'Lessons.xml', items: parseXML(lessonsXml) },
    1: { name: 'Sections.xml', items: parseXML(sectionsXml) },
    2: { name: 'Online-Angebote.xml', items: parseXML(productsXml) },
  },
  parentCatName: 'Etappen',
  mappings: [
    { src: { type: 'post_type', name: 'mpcs-lesson', fileIdx: '0' }, tgt: { name: 'post', type: 'post_type' } },
    { src: { type: 'post_type', name: 'memberpressproduct', fileIdx: '2' }, tgt: { name: 'wg_angebot', type: 'post_type' } },
    { src: { type: 'post_type', name: 'mpcs-course', fileIdx: '1' }, tgt: { name: 'child_category', type: 'category' } },
    { src: { type: 'meta', name: '_mpcs_lesson_section_id', fileIdx: '0', postType: 'mpcs-lesson' }, tgt: { name: 'section_join', type: 'join' } },
    { src: { type: 'meta', name: '_mpcs_lesson_lesson_order', fileIdx: '0', postType: 'mpcs-lesson' }, tgt: { name: 'menu_order', type: 'field' } },
    { src: { type: 'pattern', name: '[chained-quiz]', fileIdx: '0' }, tgt: { name: 'extract_chained_quiz', type: 'extract' } },
  ],
};

console.log('=== TEST 1: Standard MemberPress Setup (mpcs-course als child_category) ===');
let result = runPipeline(ST);
let val = validate(result, ST);
console.log('Posts:', result.posts.length, '| Cats:', result.cats.length);
console.log('Lessons:', val.lessonPosts, '| Mit Kategorie:', val.assigned);
console.log('Slug-Dedupes:', result.dupePostsFixed + ' posts,', result.dupeCatsFixed + ' cats');
if (val.errs.length === 0) console.log('OK: Null Fehler');
else val.errs.forEach(e => console.log('FAIL:', e.msg, e.det || ''));

console.log('\n=== TEST 2: Sections via Taxonomy (kein mpcs-course post type) ===');
const ST2 = JSON.parse(JSON.stringify(ST));
// Re-parse weil JSON.parse die Funktionen verliert
ST2.files[0].items = parseXML(lessonsXml);
ST2.files[1].items = parseXML(sectionsXml);
ST2.files[2].items = parseXML(productsXml);
ST2.mappings[2] = { src: { type: 'taxonomy', name: 'mpcs-course-categories', fileIdx: '1' }, tgt: { name: 'child_category', type: 'category' } };
result = runPipeline(ST2);
val = validate(result, ST2);
console.log('Posts:', result.posts.length, '| Cats:', result.cats.length);
console.log('Lessons:', val.lessonPosts, '| Mit Kategorie:', val.assigned);
if (val.errs.length === 0) console.log('OK: Null Fehler');
else val.errs.forEach(e => console.log('FAIL:', e.msg, e.det || ''));

console.log('\n=== TEST 3: Edge case - Lesson mit nicht-existenter section_id ===');
const ST3 = {
  files: {
    0: { name: 'Lessons.xml', items: parseXML(lessonsXml) },
    1: { name: 'Sections.xml', items: parseXML(sectionsXml) },
  },
  parentCatName: 'Etappen',
  mappings: [
    { src: { type: 'post_type', name: 'mpcs-lesson', fileIdx: '0' }, tgt: { name: 'post', type: 'post_type' } },
    { src: { type: 'post_type', name: 'mpcs-course', fileIdx: '1' }, tgt: { name: 'child_category', type: 'category' } },
    { src: { type: 'meta', name: '_mpcs_lesson_section_id', fileIdx: '0', postType: 'mpcs-lesson' }, tgt: { name: 'section_join', type: 'join' } },
  ],
};
// Manipuliere eine Lesson, gib ihr eine fake section_id
ST3.files[0].items[0].meta._mpcs_lesson_section_id = '99999';
result = runPipeline(ST3);
val = validate(result, ST3);
console.log('Lessons:', val.lessonPosts, '| Mit Kategorie:', val.assigned);
if (val.errs.find(e => (e.det || '').includes('99999'))) console.log('OK: Fake-ID korrekt als unaufloesbar markiert');
else console.log('FAIL: Fake-ID nicht erkannt');

console.log('\n=== TEST 4: Slug-Dedup (ein doppelter Lesson-Slug) ===');
const ST4 = {
  files: {
    0: { name: 'Lessons.xml', items: parseXML(lessonsXml) },
    1: { name: 'Sections.xml', items: parseXML(sectionsXml) },
  },
  parentCatName: 'Etappen',
  mappings: [
    { src: { type: 'post_type', name: 'mpcs-lesson', fileIdx: '0' }, tgt: { name: 'post', type: 'post_type' } },
    { src: { type: 'post_type', name: 'mpcs-course', fileIdx: '1' }, tgt: { name: 'child_category', type: 'category' } },
  ],
};
ST4.files[0].items[1].slug = ST4.files[0].items[0].slug; // doppelter slug
result = runPipeline(ST4);
console.log('Slug-Dedupes:', result.dupePostsFixed);
const slugs = result.posts.map(p => p.slug);
const unique = new Set(slugs).size === slugs.length;
console.log(unique ? 'OK: Alle Slugs sind unique' : 'FAIL: Es gibt noch doppelte Slugs');

console.log('\n=== TEST 5: Quiz-Extraktion ===');
const quizPosts = result.posts.filter(p => p.meta.wg_besenwagen_code);
const stillHasQuiz = result.posts.filter(p => /\[chained-quiz/.test(p.content));
console.log('Posts mit wg_besenwagen_code: 0 (kein extractMap im Test 4)');
// Test 1 result hatte extractMap
const r1 = runPipeline(ST);
const q1 = r1.posts.filter(p => p.meta.wg_besenwagen_code);
const s1 = r1.posts.filter(p => /\[chained-quiz/.test(p.content));
console.log('Test 1: Quiz-Codes extrahiert:', q1.length, '| Noch im Content:', s1.length);
console.log(q1.length === 3 && s1.length === 0 ? 'OK: 3 Quiz extrahiert, 0 verbliebene' : 'FAIL');

console.log('\n=== TEST 6: section_id ist term_id (Screenshot-Szenario) ===');
// Simuliert das Problem aus dem Screenshot: Lesson hat _mpcs_lesson_section_id=16,
// aber kein mpcs-course Post hat post_id=16. Der Term (mpcs-course-categories)
// im Channel-Header hat aber term_id=16 mit slug=e01.
const lessonsWithTermId = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<wp:wxr_version>1.2</wp:wxr_version>
<wp:term>
  <wp:term_id>16</wp:term_id>
  <wp:term_taxonomy>mpcs-course-categories</wp:term_taxonomy>
  <wp:term_slug>e01</wp:term_slug>
  <wp:term_name><![CDATA[E01]]></wp:term_name>
</wp:term>
<wp:term>
  <wp:term_id>17</wp:term_id>
  <wp:term_taxonomy>mpcs-course-categories</wp:term_taxonomy>
  <wp:term_slug>e02</wp:term_slug>
  <wp:term_name><![CDATA[E02]]></wp:term_name>
</wp:term>
<item>
  <title>Lesson A</title>
  <content:encoded><![CDATA[<p>A</p>]]></content:encoded>
  <wp:post_id>500</wp:post_id>
  <wp:post_name><![CDATA[lesson-a]]></wp:post_name>
  <wp:status><![CDATA[publish]]></wp:status>
  <wp:menu_order>0</wp:menu_order>
  <wp:post_type><![CDATA[mpcs-lesson]]></wp:post_type>
  <wp:postmeta><wp:meta_key><![CDATA[_mpcs_lesson_section_id]]></wp:meta_key><wp:meta_value><![CDATA[16]]></wp:meta_value></wp:postmeta>
</item>
<item>
  <title>Lesson B</title>
  <content:encoded><![CDATA[<p>B</p>]]></content:encoded>
  <wp:post_id>501</wp:post_id>
  <wp:post_name><![CDATA[lesson-b]]></wp:post_name>
  <wp:status><![CDATA[publish]]></wp:status>
  <wp:menu_order>0</wp:menu_order>
  <wp:post_type><![CDATA[mpcs-lesson]]></wp:post_type>
  <wp:postmeta><wp:meta_key><![CDATA[_mpcs_lesson_section_id]]></wp:meta_key><wp:meta_value><![CDATA[17]]></wp:meta_value></wp:postmeta>
</item>
</channel>
</rss>`;
// Sections.xml mit Items, die diese Term-Slugs als ihre eigene Taxonomy haben
const sectionsWithTerms = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<wp:wxr_version>1.2</wp:wxr_version>
<item>
  <title>E01 Aufstieg</title>
  <content:encoded><![CDATA[]]></content:encoded>
  <wp:post_id>700</wp:post_id>
  <wp:post_name><![CDATA[e01-aufstieg]]></wp:post_name>
  <wp:status><![CDATA[publish]]></wp:status>
  <wp:menu_order>1</wp:menu_order>
  <wp:post_type><![CDATA[mpcs-course]]></wp:post_type>
  <category domain="mpcs-course-categories" nicename="e01"><![CDATA[E01]]></category>
</item>
<item>
  <title>E02 Plateau</title>
  <content:encoded><![CDATA[]]></content:encoded>
  <wp:post_id>701</wp:post_id>
  <wp:post_name><![CDATA[e02-plateau]]></wp:post_name>
  <wp:status><![CDATA[publish]]></wp:status>
  <wp:menu_order>2</wp:menu_order>
  <wp:post_type><![CDATA[mpcs-course]]></wp:post_type>
  <category domain="mpcs-course-categories" nicename="e02"><![CDATA[E02]]></category>
</item>
</channel>
</rss>`;

const ST6 = {
  files: {
    0: { name: 'Lessons.xml', items: parseXML(lessonsWithTermId) },
    1: { name: 'Sections.xml', items: parseXML(sectionsWithTerms) },
  },
  parentCatName: 'Etappen',
  // Wir mappen die TAXONOMY als child_category — so sind cats _taxSlug-basiert
  mappings: [
    { src: { type: 'post_type', name: 'mpcs-lesson', fileIdx: '0' }, tgt: { name: 'post', type: 'post_type' } },
    { src: { type: 'taxonomy', name: 'mpcs-course-categories', fileIdx: '1' }, tgt: { name: 'child_category', type: 'category' } },
    { src: { type: 'meta', name: '_mpcs_lesson_section_id', fileIdx: '0', postType: 'mpcs-lesson' }, tgt: { name: 'section_join', type: 'join' } },
  ],
};
const r6 = runPipeline(ST6);
const v6 = validate(r6, ST6);
console.log('Posts:', r6.posts.length, '| Cats:', r6.cats.length);
console.log('Lessons:', v6.lessonPosts, '| Mit Kategorie:', v6.assigned);
const lessonA = r6.posts.find(p => p.title === 'Lesson A');
const lessonB = r6.posts.find(p => p.title === 'Lesson B');
console.log('Lesson A → Kategorien:', lessonA.categories.map(c => c.name).join(', ') || '(keine)');
console.log('Lesson B → Kategorien:', lessonB.categories.map(c => c.name).join(', ') || '(keine)');
if (v6.assigned === v6.lessonPosts && lessonA.categories.some(c => c.name === 'E01') && lessonB.categories.some(c => c.name === 'E02')) {
  console.log('OK: term_id 16/17 wurden korrekt zu E01/E02 aufgeloest');
} else {
  console.log('FAIL: Strategy 5/6 (term_id lookup) funktioniert nicht');
  v6.errs.forEach(e => console.log('  -', e.msg, e.det || ''));
}

console.log('\n=== ALLE TESTS DURCHGELAUFEN ===');
