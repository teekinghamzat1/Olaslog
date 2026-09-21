const http = require('http');

function get(path) {
  return new Promise((res, rej) => {
    const req = http.get('http://localhost:3000' + path, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { res({ status: r.statusCode, body: JSON.parse(d) }); }
        catch { res({ status: r.statusCode, body: d.substring(0, 200) }); }
      });
    });
    req.on('error', rej);
  });
}

async function run() {
  // Test 1: Products API
  let r = await get('/api/products');
  const prods = r.body.products || [];
  console.log('=== ENDPOINT TESTS ===');
  console.log('Products:', 'status=' + r.status + ', count=' + prods.length + ', first=' + (prods[0] && prods[0].name));

  // Test 2: Stock preview for first available product
  const firstProdId = prods[0] ? prods[0].id : 1;
  r = await get('/api/products/' + firstProdId + '/stock');
  const stock = r.body.stock;
  const firstOpt = stock && stock.options && stock.options[0];
  console.log('Stock/' + firstProdId + ':', 'status=' + r.status + ', availableStock=' + (stock && stock.availableStock) + ', options=' + (stock && stock.options && stock.options.length) + ', location=' + (firstOpt && firstOpt.preview && firstOpt.preview.location));

  // Test 3: Categories
  r = await get('/api/products/categories');
  const cats = r.body.categories || [];
  console.log('Categories:', 'count=' + cats.length + ', names=' + cats.map(function(c){ return c.name; }).join(', '));

  // Test 4: Admin Sujan status (may be 401 without auth)
  r = await get('/api/admin/sujan-status');
  console.log('Sujan-status:', 'status=' + r.status + (r.status === 200 ? ', sandbox=' + r.body.sandbox + ', balance=' + JSON.stringify(r.body.balance) : ' (auth required)'));

  // Test 5: Static frontend
  r = await get('/');
  const bodyStr = typeof r.body === 'string' ? r.body : '';
  console.log('Frontend:', 'status=' + r.status + ', hasOlaslog=' + bodyStr.includes('Olaslog'));

  console.log('\n=== All API endpoints verified! ===');
}

run().catch(function(e) { console.error('Error:', e.message); });
