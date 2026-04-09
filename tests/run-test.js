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
  const parentMap = mappings.find(m => m.tgt.name === 'parent_category');
  const joinMap = mappings.find(m => m.tgt.name === 'section_join');
  const extractMap = mappings.find(m => m.tgt.name === 'extract_chained_quiz');

  const cats = [];
  let catId = 100001;
  const parentCats = [];

  // Modell B: parent_category aus post_type
  if (parentMap && parentMap.src.type === 'post_type') {
    const parentItems = allItems.filter(i => i.postType === parentMap.src.name);
    for (const it of parentItems) {
      const pc = {
        termId: catId++,
        name: it.title,
        slug: it.slug || slug(it.title),
        parentSlug: '',
        _srcId: String(it.postId),
        _ownTaxSlugs: it.taxonomies.map(t => t.slug),
      };
      cats.push(pc);
      parentCats.push(pc);
    }
  }

  // Modell A: parent_category als manueller String
  let parentCat = null;
  if (parentCats.length === 0 && catMap) {
    const pName = ST.parentCatName || 'Etappen';
    parentCat = { termId: catId++, name: pName, slug: slug(pName), parentSlug: '' };
    cats.push(parentCat);
    parentCats.push(parentCat);
  }

  if (catMap) {
    const src = catMap.src;
    if (src.type === 'post_type') {
      const items = allItems.filter(i => i.postType === src.name);
      for (const it of items) {
        let pSlug = parentCats[0]?.slug || '';
        if (parentCats.length > 1) {
          const owner = parentCats.find(p => p._ownTaxSlugs && it.taxonomies.some(tx => p._ownTaxSlugs.includes(tx.slug)));
          if (owner) pSlug = owner.slug;
        }
        cats.push({ termId: catId++, name: it.title, slug: it.slug || slug(it.title), parentSlug: pSlug, _srcId: String(it.postId) });
      }
    } else if (src.type === 'taxonomy') {
      const seen = new Set();
      for (const it of allItems) {
        for (const tx of it.taxonomies) {
          if (tx.taxonomy === src.name && !seen.has(tx.slug)) {
            seen.add(tx.slug);
            let pSlug = parentCats[0]?.slug || '';
            if (parentCats.length > 1) {
              const owner = parentCats.find(p => p._ownTaxSlugs && p._ownTaxSlugs.includes(tx.slug));
              if (owner) pSlug = owner.slug;
            }
            cats.push({ termId: catId++, name: tx.term, slug: tx.slug, parentSlug: pSlug, _taxSlug: tx.slug });
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

  const findParentFor = (childCat) => {
    if (!childCat || !childCat.parentSlug) return null;
    return cats.find(c => c.slug === childCat.parentSlug) || null;
  };

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
        } else if (mm.tgt.type === 'transform') {
          if (mm.tgt.name === 'split_benefits') {
            let raw = String(val || '');
            if (/^a:\d+:\{/.test(raw)) {
              const matches = raw.match(/s:\d+:"([^"]*)"/g) || [];
              const parts = matches.map(s => s.replace(/^s:\d+:"|"$/g, '')).filter(Boolean);
              parts.slice(0, 5).forEach((p, i) => { post.meta['benefit_' + (i + 1)] = p; });
            } else {
              const parts = raw.split(/\r?\n|\||;/).map(s => s.trim()).filter(Boolean);
              parts.slice(0, 5).forEach((p, i) => { post.meta['benefit_' + (i + 1)] = p; });
            }
          }
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
                let pSlugForNew = parentCats[0]?.slug || '';
                if (parentCats.length > 1) {
                  const owner = parentCats.find(p => p._ownTaxSlugs && secItem.taxonomies.some(tx => p._ownTaxSlugs.includes(tx.slug)));
                  if (owner) pSlugForNew = owner.slug;
                }
                const newCat = { termId: catId++, name: secItem.title, slug: secItem.slug || slug(secItem.title), parentSlug: pSlugForNew, _srcId: String(secItem.postId) };
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
            const pc = findParentFor(mc);
            if (pc) post.categories.push({ name: pc.name, slug: pc.slug });
          } else {
            post._unresolved = secId;
          }
        } else {
          for (const tx of item.taxonomies) {
            const mc = taxSlugToCat[tx.slug] || slugToCat[tx.slug] || nameToCat[tx.term];
            if (mc) {
              post.categories.push({ name: mc.name, slug: mc.slug });
              const pc = findParentFor(mc);
              if (pc) post.categories.push({ name: pc.name, slug: pc.slug });
              break;
            }
          }
        }
      } else {
        for (const tx of item.taxonomies) {
          const mc = taxSlugToCat[tx.slug] || slugToCat[tx.slug] || nameToCat[tx.term];
          if (mc && !post.categories.some(c => c.slug === mc.slug)) {
            post.categories.push({ name: mc.name, slug: mc.slug });
            const pc = findParentFor(mc);
            if (pc && !post.categories.some(c => c.slug === pc.slug)) {
              post.categories.push({ name: pc.name, slug: pc.slug });
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

console.log('\n=== TEST 7: Produkt-Meta-Mappings + split_benefits ===');
const ST7 = {
  files: {
    0: { name: 'Online-Angebote.xml', items: parseXML(productsXml) },
  },
  parentCatName: 'Etappen',
  mappings: [
    { src: { type: 'post_type', name: 'memberpressproduct', fileIdx: '0' }, tgt: { name: 'wg_angebot', type: 'post_type' } },
    { src: { type: 'meta', name: '_mepr_product_price', fileIdx: '0', postType: 'memberpressproduct' }, tgt: { name: 'nettopreis', type: 'meta' } },
    { src: { type: 'meta', name: '_mepr_product_pricing_heading_text', fileIdx: '0', postType: 'memberpressproduct' }, tgt: { name: 'heading_text', type: 'meta' } },
    { src: { type: 'meta', name: '_mepr_product_pricing_footer_text', fileIdx: '0', postType: 'memberpressproduct' }, tgt: { name: 'footer_text', type: 'meta' } },
    { src: { type: 'meta', name: '_mepr_product_pricing_benefits', fileIdx: '0', postType: 'memberpressproduct' }, tgt: { name: 'split_benefits', type: 'transform' } },
  ],
};
const r7 = runPipeline(ST7);
const premium = r7.posts.find(p => p.title === 'Premium Angebot');
console.log('Premium Angebot - Felder:');
console.log('  nettopreis:', premium?.meta.nettopreis);
console.log('  heading_text:', premium?.meta.heading_text);
console.log('  footer_text:', premium?.meta.footer_text);
console.log('  benefit_1:', premium?.meta.benefit_1);
console.log('  benefit_2:', premium?.meta.benefit_2);
console.log('  benefit_3:', premium?.meta.benefit_3);
console.log('  benefit_4:', premium?.meta.benefit_4);
const allOk = premium
  && premium.meta.nettopreis === '99.00'
  && premium.meta.heading_text === 'Jetzt buchen'
  && premium.meta.footer_text === 'Inkl. MwSt.'
  && premium.meta.benefit_1 === 'Volle Kursinhalte'
  && premium.meta.benefit_2 === 'Lebenslanger Zugang'
  && premium.meta.benefit_3 === 'Community-Zugriff'
  && premium.meta.benefit_4 === 'Persoenlicher Support';
console.log(allOk ? 'OK: Produkt-Felder + benefit_1..4 korrekt befuellt' : 'FAIL: Produkt-Felder unvollstaendig');

console.log('\n=== TEST 8: split_benefits mit Pipe-Trenner ===');
const ST8 = JSON.parse(JSON.stringify(ST7));
ST8.files[0].items = parseXML(productsXml);
ST8.files[0].items.find(i => i.title === 'Premium Angebot').meta._mepr_product_pricing_benefits = 'A | B | C | D | E | F | G';
const r8 = runPipeline(ST8);
const p8 = r8.posts.find(p => p.title === 'Premium Angebot');
const ok8 = p8.meta.benefit_1 === 'A' && p8.meta.benefit_5 === 'E' && p8.meta.benefit_6 === undefined;
console.log('benefit_1=' + p8.meta.benefit_1 + ', benefit_5=' + p8.meta.benefit_5 + ', benefit_6=' + p8.meta.benefit_6);
console.log(ok8 ? 'OK: Pipe-Trenner + max-5-Limit funktionieren' : 'FAIL');

console.log('\n=== TEST 9: split_benefits mit PHP-serialisiertem Array ===');
const ST9 = JSON.parse(JSON.stringify(ST7));
ST9.files[0].items = parseXML(productsXml);
ST9.files[0].items.find(i => i.title === 'Premium Angebot').meta._mepr_product_pricing_benefits = 'a:3:{i:0;s:5:"Erste";i:1;s:7:"Zweiter";i:2;s:7:"Dritter";}';
const r9 = runPipeline(ST9);
const p9 = r9.posts.find(p => p.title === 'Premium Angebot');
const ok9 = p9.meta.benefit_1 === 'Erste' && p9.meta.benefit_2 === 'Zweiter' && p9.meta.benefit_3 === 'Dritter';
console.log('benefit_1=' + p9.meta.benefit_1 + ', benefit_2=' + p9.meta.benefit_2 + ', benefit_3=' + p9.meta.benefit_3);
console.log(ok9 ? 'OK: PHP-serialisierte Benefits werden korrekt geparsed' : 'FAIL');

console.log('\n=== TEST 10: Modell B - mehrere Kurse als parent_category ===');
// Szenario: 2 mpcs-course Items (Marketing-Kurs, Verkaufs-Kurs).
// 4 Sektionen via mpcs-course-categories Taxonomie.
// Jeder Kurs hat 2 Sektionen (über eigene category-Tags markiert).
// Lessons sollen automatisch dem richtigen Kurs zugeordnet werden.
const lessonsB = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<wp:wxr_version>1.2</wp:wxr_version>
<item>
  <title>Marketing Lektion 1</title>
  <content:encoded><![CDATA[<p>L1</p>]]></content:encoded>
  <wp:post_id>800</wp:post_id>
  <wp:post_name><![CDATA[marketing-l1]]></wp:post_name>
  <wp:status><![CDATA[publish]]></wp:status>
  <wp:menu_order>1</wp:menu_order>
  <wp:post_type><![CDATA[mpcs-lesson]]></wp:post_type>
  <category domain="mpcs-course-categories" nicename="m-grundlagen"><![CDATA[Marketing Grundlagen]]></category>
</item>
<item>
  <title>Marketing Lektion 2</title>
  <content:encoded><![CDATA[<p>L2</p>]]></content:encoded>
  <wp:post_id>801</wp:post_id>
  <wp:post_name><![CDATA[marketing-l2]]></wp:post_name>
  <wp:status><![CDATA[publish]]></wp:status>
  <wp:menu_order>2</wp:menu_order>
  <wp:post_type><![CDATA[mpcs-lesson]]></wp:post_type>
  <category domain="mpcs-course-categories" nicename="m-fortgeschritten"><![CDATA[Marketing Fortgeschritten]]></category>
</item>
<item>
  <title>Verkauf Lektion 1</title>
  <content:encoded><![CDATA[<p>L3</p>]]></content:encoded>
  <wp:post_id>802</wp:post_id>
  <wp:post_name><![CDATA[verkauf-l1]]></wp:post_name>
  <wp:status><![CDATA[publish]]></wp:status>
  <wp:menu_order>1</wp:menu_order>
  <wp:post_type><![CDATA[mpcs-lesson]]></wp:post_type>
  <category domain="mpcs-course-categories" nicename="v-grundlagen"><![CDATA[Verkauf Grundlagen]]></category>
</item>
<item>
  <title>Verkauf Lektion 2</title>
  <content:encoded><![CDATA[<p>L4</p>]]></content:encoded>
  <wp:post_id>803</wp:post_id>
  <wp:post_name><![CDATA[verkauf-l2]]></wp:post_name>
  <wp:status><![CDATA[publish]]></wp:status>
  <wp:menu_order>2</wp:menu_order>
  <wp:post_type><![CDATA[mpcs-lesson]]></wp:post_type>
  <category domain="mpcs-course-categories" nicename="v-abschluss"><![CDATA[Verkauf Abschluss]]></category>
</item>
</channel>
</rss>`;

const coursesB = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<wp:wxr_version>1.2</wp:wxr_version>
<item>
  <title>Marketing Kurs</title>
  <content:encoded><![CDATA[]]></content:encoded>
  <wp:post_id>900</wp:post_id>
  <wp:post_name><![CDATA[marketing-kurs]]></wp:post_name>
  <wp:status><![CDATA[publish]]></wp:status>
  <wp:menu_order>1</wp:menu_order>
  <wp:post_type><![CDATA[mpcs-course]]></wp:post_type>
  <category domain="mpcs-course-categories" nicename="m-grundlagen"><![CDATA[Marketing Grundlagen]]></category>
  <category domain="mpcs-course-categories" nicename="m-fortgeschritten"><![CDATA[Marketing Fortgeschritten]]></category>
</item>
<item>
  <title>Verkaufs Kurs</title>
  <content:encoded><![CDATA[]]></content:encoded>
  <wp:post_id>901</wp:post_id>
  <wp:post_name><![CDATA[verkaufs-kurs]]></wp:post_name>
  <wp:status><![CDATA[publish]]></wp:status>
  <wp:menu_order>2</wp:menu_order>
  <wp:post_type><![CDATA[mpcs-course]]></wp:post_type>
  <category domain="mpcs-course-categories" nicename="v-grundlagen"><![CDATA[Verkauf Grundlagen]]></category>
  <category domain="mpcs-course-categories" nicename="v-abschluss"><![CDATA[Verkauf Abschluss]]></category>
</item>
</channel>
</rss>`;

const ST10 = {
  files: {
    0: { name: 'Lessons.xml', items: parseXML(lessonsB) },
    1: { name: 'Courses.xml', items: parseXML(coursesB) },
  },
  parentCatName: 'Kurse',
  mappings: [
    { src: { type: 'post_type', name: 'mpcs-lesson', fileIdx: '0' }, tgt: { name: 'post', type: 'post_type' } },
    { src: { type: 'post_type', name: 'mpcs-course', fileIdx: '1' }, tgt: { name: 'parent_category', type: 'category' } },
    { src: { type: 'taxonomy', name: 'mpcs-course-categories', fileIdx: '0' }, tgt: { name: 'child_category', type: 'category' } },
  ],
};
const r10 = runPipeline(ST10);
const v10 = validate(r10, ST10);
console.log('Posts:', r10.posts.length, '| Cats:', r10.cats.length);
console.log('Lessons:', v10.lessonPosts, '| Mit Kategorie:', v10.assigned);
console.log('Kategorien-Baum:');
const parents = r10.cats.filter(c => !c.parentSlug);
for (const p of parents) {
  console.log('  -', p.name, '(parent)');
  for (const c of r10.cats.filter(c => c.parentSlug === p.slug)) {
    console.log('      -', c.name, '(child)');
  }
}
const ml1 = r10.posts.find(p => p.title === 'Marketing Lektion 1');
const vl1 = r10.posts.find(p => p.title === 'Verkauf Lektion 1');
console.log('Marketing L1 -> Kategorien:', ml1.categories.map(c => c.name).join(', '));
console.log('Verkauf L1 -> Kategorien:', vl1.categories.map(c => c.name).join(', '));
const okML = ml1.categories.some(c => c.name === 'Marketing Grundlagen') && ml1.categories.some(c => c.name === 'Marketing Kurs');
const okVL = vl1.categories.some(c => c.name === 'Verkauf Grundlagen') && vl1.categories.some(c => c.name === 'Verkaufs Kurs');
const noWrongML = !ml1.categories.some(c => c.name === 'Verkaufs Kurs');
const noWrongVL = !vl1.categories.some(c => c.name === 'Marketing Kurs');
if (okML && okVL && noWrongML && noWrongVL && parents.length === 2) {
  console.log('OK: 2 Parents, jede Lektion korrekt unter ihrem Kurs einsortiert');
} else {
  console.log('FAIL:');
  if (!okML) console.log('  - Marketing L1 fehlt Marketing-Kategorien');
  if (!okVL) console.log('  - Verkauf L1 fehlt Verkauf-Kategorien');
  if (!noWrongML) console.log('  - Marketing L1 ist faelschlich unter Verkaufs Kurs');
  if (!noWrongVL) console.log('  - Verkauf L1 ist faelschlich unter Marketing Kurs');
  if (parents.length !== 2) console.log('  - Erwartet 2 Parents, gefunden ' + parents.length);
}

console.log('\n=== ALLE TESTS DURCHGELAUFEN ===');
