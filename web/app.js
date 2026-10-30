import { staticProduct } from './static-products.js';
import { breachCount, runningMean } from './stats.js';
const $=id=>document.getElementById(id);
const staticMode=document.documentElement.dataset.static==='true';
const chainHref=staticMode?'./data/chains.json':'/chains';
let staticBundle;
const colors={ssp:'#d5a24a',gcm:'#708bad',ds:'#76a597',bc:'#b6c997',hydro:'#967ba1',interaction:'#c48a73',internal:'#bfc6d0'};
const names={ssp:'Scenario spread',gcm:'GCM',ds:'Downscaling',bc:'Bias correction',hydro:'Hydrology',interaction:'Interaction',internal:'Internal variability'};
const factors=['gcm','ds','bc','hydro','member'];
let meta,chains,cube,products,active=[],generation=0;
const base=()=>`node=${encodeURIComponent($('node').value)}&metric=${encodeURIComponent($('metric').value)}`;
async function get(path){
 if(staticMode){
  staticBundle??=fetch(new URL('./data/demo.json',document.baseURI)).then(r=>{if(!r.ok)throw Error(`Static data: ${r.status}`);return r.json()});
  return staticProduct(await staticBundle,path);
 }
 const r=await fetch(path);if(!r.ok)throw Error(`${path}: ${r.status}`);return r.json();
}
const comp=r=>Object.keys(colors).reduce((sum,f)=>sum+r[f],0);
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
function quantile(sorted,p){const i=(sorted.length-1)*p,l=Math.floor(i);return sorted[l]+(sorted[Math.ceil(i)]-sorted[l])*(i-l)}
const timescale=()=>$('timescale').value;
const scaleLabel=()=>timescale()==='annual'?'single-year values':'10-year means';
let smoothed;
function view(){if(timescale()==='annual')return cube;smoothed??={years:runningMean(cube.years,cube.values[0]).years,values:cube.values.map(v=>runningMean(cube.years,v).values)};return smoothed}
function fanData(ids){const c=view();return c.years.map((year,j)=>{const a=ids.map(i=>c.values[i][j]).sort((a,b)=>a-b);return {year,p05:quantile(a,.05),p10:quantile(a,.1),p50:quantile(a,.5),p90:quantile(a,.9),p95:quantile(a,.95)}}).filter(r=>r.year>=2020)}
function svg(content,h=280){return `<svg viewBox="0 0 1100 ${h}" role="img">${content}</svg>`}
function polygon(rows,lo,hi,x,y){return rows.map(r=>`${x(r.year)},${y(hi(r))}`).concat([...rows].reverse().map(r=>`${x(r.year)},${y(lo(r))}`)).join(' ')}
function path(rows,value,x,y){return rows.map((r,i)=>`${i?'L':'M'}${x(r.year)},${y(value(r))}`).join(' ')}
function axes(x,y,low,high,h=280){let s='';for(let v=Math.ceil(low/20)*20;v<=high;v+=20)s+=`<line x1="65" x2="1070" y1="${y(v)}" y2="${y(v)}" stroke="#e8ede7"/><text x="52" y="${y(v)+4}" text-anchor="end">${v}%</text>`;for(let year=2020;year<=2100;year+=20)s+=`<text x="${x(year)}" y="${h-10}" text-anchor="middle">${year}</text>`;return s}
function redraw(){
 const start=performance.now(),scenario=$('ssp').value;
 const full=chains.flatMap((c,i)=>scenario==='all'||c.ssp===scenario?[i]:[]);
 active=full.filter(i=>factors.every(f=>$(`fix-${f}`).value==='all'||chains[i][f]===$(`fix-${f}`).value));
 document.querySelectorAll('.chain-note').forEach(el=>el.innerHTML=`n = ${active.length} of ${full.length} chains · GCMs: ${[...new Set(active.map(i=>chains[i].gcm))].join(', ')||'none'} · <a href="${chainHref}" target="_blank" rel="noopener">Chain list ↗</a> · ${meta.build_id}`);
 if(!active.length){$('status').textContent='No chains match these filters. Reset the slicers to restore the ensemble.';for(const id of ['fan','shares','breaches','cascade','futures'])$(id).innerHTML='No matching chains.';return}
 const filtered=fanData(active),fullFan=fanData(full),v=products.variance.filter(r=>r.year>=2020).sort((a,b)=>a.year-b.year),q=products.quantiles.filter(r=>r.year>=2020).sort((a,b)=>a.year-b.year);
 const threshold=Number($('threshold').value);
 if(!Number.isFinite(threshold)||$('threshold').value===''){$('status').textContent='Enter a finite runoff threshold.';return}
 const low=Math.floor(Math.min(-40,threshold,...fullFan.map(r=>r.p05),...q.map((r,i)=>r.mean-1.645*Math.sqrt(v[i].total)))/20)*20;
 const high=Math.ceil(Math.max(20,threshold,...fullFan.map(r=>r.p95),...q.map((r,i)=>r.mean+1.645*Math.sqrt(v[i].total)))/20)*20;
 const x=yr=>65+(yr-2020)/80*1005,y=val=>240-(val-low)/(high-low)*210;
 let s=axes(x,y,low,high);
 for(const [yr,label] of [[2035,'Near'],[2055,'Mid']])s+=`<line x1="${x(yr)}" x2="${x(yr)}" y1="22" y2="240" stroke="#ccd7ca" stroke-dasharray="4 4"/><text x="${x(yr)+5}" y="22">${label}</text>`;
 s+=`<text x="${x(2080)}" y="22">Long term</text><polygon points="${polygon(fullFan,r=>r.p10,r=>r.p90,x,y)}" fill="#dfe3df"/>`;
 const sliced=active.length!==full.length;
 if($('mode').value==='partitioned'&&!sliced){
  const order=['internal','hydro','bc','ds','gcm','ssp','interaction'];
  const bands=order.map((f,k)=>q.map((r,i)=>({...r,width:1.645*Math.sqrt(order.slice(0,k+1).reduce((sum,f)=>sum+v[i][f],0))})));
  for(let k=order.length-1;k>=0;k--)s+=`<polygon points="${polygon(bands[k],r=>r.mean-r.width,r=>r.mean+r.width,x,y)}" fill="${colors[order[k]]}" fill-opacity=".65"/>`;
 }else s+=`<polygon points="${polygon(filtered,r=>r.p10,r=>r.p90,x,y)}" fill="#4c8d77" fill-opacity=".6"/><path d="${path(filtered,r=>r.p50,x,y)}" fill="none" stroke="#235947" stroke-width="2"/>`;
 s+=`<path d="${path(q,r=>r.mean,x,y)}" fill="none" stroke="#234c45" stroke-dasharray="6 4" stroke-width="1.7"/>`;
 const mismatch=q.some((r,i)=>Math.abs(2*1.645*Math.sqrt(v[i].total)-(r.p95-r.p05))/Math.max(r.p95-r.p05,1e-9)>.1);
 if(mismatch)for(const side of ['p05','p95'])s+=`<path d="${path(q,r=>r[side],x,y)}" fill="none" stroke="#606b66" stroke-dasharray="2 4"/>`;
 s+=`<line x1="65" x2="1070" y1="${y(threshold)}" y2="${y(threshold)}" stroke="#a36143" stroke-dasharray="7 4"/><text x="1066" y="${y(threshold)-5}" text-anchor="end">Threshold ${threshold}%</text>`;
 $('fan').innerHTML=svg(s);
 $('agreement').textContent=`Timescale: ${scaleLabel()} (all fan, share and cascade values; breach rules stay annual). ${sliced?'Slicers active: showing empirical filtered fan; variance shares below remain for the full scenario selection. ':''}${mismatch?'Range agreement flag: empirical P05–P95 and partitioned 90% widths differ by over 10%; dotted empirical limits shown.':'Empirical and partitioned 90% widths agree within 10%.'} ${scenario==='all'?'All scenarios pooled with equal design counts; SSPs have no assigned probabilities.':''}`;
 let area='';let cumulative=v.map(()=>0);for(const f of Object.keys(colors)){const rows=v.map((r,i)=>{const lo=cumulative[i];const hi=lo+(comp(r)?100*r[f]/comp(r):0);cumulative[i]=hi;return {year:r.year,lo,hi}});area+=`<polygon points="${polygon(rows,r=>r.lo,r=>r.hi,x,z=>110-z)}" fill="${colors[f]}"/>`}
 area+=`<text x="52" y="18" text-anchor="end">100%</text><text x="52" y="113" text-anchor="end">0%</text><text x="65" y="138">Fraction of total variance · unsliced scenario ensemble · ${scaleLabel()}</text>`;
 $('shares').innerHTML=svg(area,150);
 drawCascade();drawBreaches(threshold);drawFutures();
 $('status').textContent=`${active.length} chains selected · local redraw ${(performance.now()-start).toFixed(0)} ms · ${scenario==='all'?'pooled scenarios':scenario}`;
}
function drawCascade(){
 const rows=[...products.cascade].sort((a,b)=>a.order-b.order),h=Number($('horizon').value);
 const v=products.variance.filter(r=>timescale()==='annual'?r.year>=h&&r.year<h+10:r.year===h+5),total=mean(v.map(comp));
 const shares=Object.fromEntries(Object.keys(colors).map(f=>[f,total?100*mean(v.map(r=>r[f]))/total:0]));
 $('headline').textContent=`Climate ${(shares.ssp+shares.gcm+shares.ds+shares.bc).toFixed(0)}% · Hydro ${shares.hydro.toFixed(0)}% · IV ${shares.internal.toFixed(0)}% · Interactions ${shares.interaction.toFixed(0)}% · ${scaleLabel()}`;
 const lo=Math.min(...rows.map(r=>r.p10)),hi=Math.max(...rows.map(r=>r.p90)),scale=z=>165-(z-lo)/Math.max(hi-lo,1)*125;
 let s='';rows.forEach((r,i)=>{const cx=95+i*180,ny=rows[i+1];if(ny)s+=`<polygon points="${cx},${scale(r.p10)} ${cx+180},${scale(ny.p10)} ${cx+180},${scale(ny.p90)} ${cx},${scale(r.p90)}" fill="${colors[r.stage]}" fill-opacity=".7"/>`;s+=`<line x1="${cx}" x2="${cx}" y1="${scale(r.p10)}" y2="${scale(r.p90)}" stroke="${colors[r.stage]}" stroke-width="3"/><circle cx="${cx}" cy="${scale(r.p50)}" r="3" fill="#254b40"/><text x="${cx}" y="195" text-anchor="middle">${names[r.stage]}</text><text x="${cx}" y="215" text-anchor="middle">${shares[r.stage].toFixed(1)}% · [${r.p10.toFixed(0)}, ${r.p90.toFixed(0)}]%</text>`});$('cascade').innerHTML=svg(s,235);
}
function drawBreaches(threshold){
 const rule=$('rule').value,n=Number($('persistent').value);$('persistent').disabled=!['dry_years_per_decade','consecutive_run'].includes(rule);
 if(!$('persistent').disabled&&(!Number.isInteger(n)||n<1||n>10)){$('breaches').textContent='Dry-year count must be an integer from 1 to 10.';return}
 $('rule-label').textContent=`${rule==='annual'?'Annual: chain-years':rule==='dry_years_per_decade'?`At least ${n} dry years per decade: chains with ≥ ${n} years`:rule==='consecutive_run'?`At least ${n} consecutive dry years: chains with a run ≥ ${n} years`:'Decadal mean: chains with mean'} below ${threshold}% change in each decade.`;
 const decades=[2030,2040,2050,2060,2070,2080,2090];let html='<table><thead><tr><th>Scenario</th>'+decades.map(d=>`<th>${d}s</th>`).join('')+'</tr></thead><tbody>';
 for(const scenario of meta.levels.ssp){const ids=active.filter(i=>chains[i].ssp===scenario);html+=`<tr><th>${scenario}</th>`;for(const d of decades){if(!ids.length){html+='<td>—<small>n = 0</small></td>';continue}const js=cube.years.flatMap((y,j)=>y>=d&&y<d+10?[j]:[]);let count=0;for(const i of ids){const a=js.map(j=>cube.values[i][j]);count+=breachCount(a,threshold,rule,n)}const denominator=ids.length*(rule==='annual'?js.length:1),share=count/denominator;html+=`<td style="background:rgba(177,105,64,${.05+share*.55})">${(share*100).toFixed(0)}%<small>${count} / ${denominator} ${rule==='annual'?'chain-years':'chains'}<br>n = ${ids.length}</small></td>`}html+='</tr>'}
 $('breaches').innerHTML=html+'</tbody></table>';
}
function drawFutures(){const included=new Set(active.map(i=>chains[i].gcm));const classes=['Much drier','Drier','Little change','Wetter'];let html='';for(const ssp of meta.levels.ssp){if($('ssp').value!=='all'&&$('ssp').value!==ssp)continue;const rows=products.futures.filter(r=>r.ssp===ssp);html+=`<h4>${ssp}</h4><div class="table-wrap"><table><thead><tr><th>Temperature / Rainfall</th>${classes.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>`;for(const t of ['Warmer','Hotter','Much hotter']){html+=`<tr><th>${t}</th>`;for(const p of classes){const cell=rows.filter(r=>r.temperature_class===t&&r.rainfall_class===p);const n=cell.filter(r=>included.has(r.gcm)).length;html+=`<td style="background:${n?'#dfebd9':'#f2f4f0'}">${cell.length} / ${rows.length} models<small>${n} included${cell.length?'<br>'+cell.map(r=>r.gcm).join('<br>'):''}</small></td>`}html+='</tr>'}html+='</tbody></table></div>'} $('futures').innerHTML=html}
async function refresh(){const version=++generation;$('status').textContent='Reading versioned products…';try{const ssp=encodeURIComponent($('ssp').value),h=$('horizon').value,b=base();const responses=await Promise.all([get(`/variance?${b}&ssp=${ssp}&timescale=${timescale()}`),get(`/quantiles?${b}&ssp=${ssp}&timescale=${timescale()}`),get(`/cascade?${b}&ssp=${ssp}&horizon=${h}&timescale=${timescale()}`),...meta.levels.ssp.map(s=>get(`/futures?horizon=${h}&ssp=${encodeURIComponent(s)}`))]);if(version!==generation)return;if(responses.some(r=>r.build_id!==meta.build_id))throw Error('Product release changed. Reload the page.');products={variance:responses[0].data.map(r=>({...r,...Object.fromEntries(Object.entries(r).filter(([k])=>k.startsWith("var_")).map(([k,v])=>[k.slice(4),v]))})),quantiles:responses[1].data,cascade:responses[2].data,futures:responses.slice(3).flatMap(r=>r.data)};redraw()}catch(e){$('status').textContent=`Unable to load products: ${e.message}`}}
function reset(){factors.forEach(f=>$(`fix-${f}`).value='all')}
async function init(){try{document.querySelectorAll('[data-chain-catalogue]').forEach(a=>a.href=chainHref);meta=await get('/metadata');const [chainResponse,cubeResponse]=await Promise.all([get('/chains'),get(`/cube?${base()}&format=json`)]);if(chainResponse.build_id!==meta.build_id||cubeResponse.build_id!==meta.build_id)throw Error('Inconsistent product release');chains=chainResponse.data;cube=cubeResponse.data;
 $('release').innerHTML=`${meta.n_chains} ensemble chains<br>3 scenarios · 3 GCMs<br>Baseline: ${meta.baseline}`;$('build').textContent=meta.build_id;
 $('legend').innerHTML=Object.keys(colors).map(f=>`<span><i style="background:${colors[f]}"></i>${names[f]}</span>`).join('');
 $('slicers').innerHTML=factors.map(f=>`<label>${names[f]||'Realisation'}<select id="fix-${f}"><option value="all">All levels</option>${meta.levels[f].map(l=>`<option>${l}</option>`).join('')}</select></label>`).join('');
 $('provenance').textContent=`${meta.build_id} · ${meta.weighting}. ${meta.smoothing}. All chain provenance is synthetic. Main-effect estimates have no bootstrap intervals yet. Historical and calibration gates have not passed.`;
 $('qa').textContent=JSON.stringify(meta.qa,null,2);
 for(const id of ['ssp','horizon','node','metric','timescale'])$(id).addEventListener('change',refresh);
 for(const id of ['mode','threshold','rule','persistent',...factors.map(f=>`fix-${f}`)])$(id).addEventListener('change',()=>products&&redraw());
 $('reset').onclick=()=>{reset();redraw()};$('climate').onclick=()=>{reset();$('fix-hydro').value='P03';redraw()};$('hydrology').onclick=()=>{reset();$('ssp').value='SSP2-4.5';for(const f of ['gcm','ds','bc','member'])$(`fix-${f}`).value=meta.levels[f][0];refresh()};
 $('export').onclick=()=>{const rows=[`# build_id=${meta.build_id}; SYNTHETIC; ${meta.baseline}`,'chain_id,ssp,gcm,ds,bc,hydro,member,year,delta_percent'];for(const i of active)cube.years.forEach((year,j)=>rows.push([chains[i].chain_id,...Object.keys(meta.levels).map(f=>chains[i][f]),year,cube.values[i][j]].join(',')));const url=URL.createObjectURL(new Blob([rows.join('\n')],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download=`${meta.build_id}-filtered.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
 await refresh();}catch(e){$('status').textContent=`Startup failed: ${e.message}`}}
init();
