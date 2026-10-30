import { staticProduct } from './static-products.js';
import { breachGrid, describeFan, esc, fanRows, headlineShares, horizonRows, mean, runningMean, selectChains, toCsv } from './stats.js';
const $=id=>document.getElementById(id);
const staticMode=document.documentElement.dataset.static==='true';
const chainHref=staticMode?'./data/chains.json':'/chains';
let staticBundle;
const colors={ssp:'#d5a24a',gcm:'#708bad',ds:'#76a597',bc:'#b6c997',hydro:'#967ba1',interaction:'#c48a73',internal:'#bfc6d0'};
const names={ssp:'Scenario spread',gcm:'GCM',ds:'Downscaling',bc:'Bias correction',hydro:'Hydrological parameters',interaction:'Interaction',internal:'Internal variability'};
const factors=['gcm','ds','bc','hydro','member'];
const factorLabel=f=>names[f]||'Realisation';
const decades=[2030,2040,2050,2060,2070,2080,2090];
const cubes={};
let meta,chains,cube,products,active=[],generation=0,smoothed;
const base=()=>`node=${encodeURIComponent($('node').value)}&metric=${encodeURIComponent($('metric').value)}`;
async function get(path){
 if(staticMode){
  staticBundle??=fetch(new URL('./data/demo.json',document.baseURI)).then(r=>{if(!r.ok)throw Error(`Static data: ${r.status}`);return r.json()});
  return staticProduct(await staticBundle,path);
 }
 const r=await fetch(path);if(!r.ok)throw Error(`${path}: ${r.status}`);return r.json();
}
const comp=r=>Object.keys(colors).reduce((sum,f)=>sum+r[f],0);
const metricInfo=()=>meta.metrics.find(m=>m.id===$('metric').value);
const isPct=()=>!!metricInfo().threshold_id,suffix=()=>isPct()?'%':'';
const timescale=()=>$('timescale').value;
const scaleLabel=()=>timescale()==='annual'?'single-year values':'10-year means';
const scenarioLabel=()=>$('ssp').value==='all'?'All scenarios pooled':$('ssp').value;
const fixedValues=()=>Object.fromEntries(factors.map(f=>[f,$(`fix-${f}`).value]));
async function ensureCube(){const m=$('metric').value;if(!cubes[m]){const r=await get(`/cube?${base()}&format=json`);if(r.build_id!==meta.build_id)throw Error('Inconsistent product release');cubes[m]=r.data}if(cube!==cubes[m]){cube=cubes[m];smoothed=undefined}}
function view(){if(timescale()==='annual')return cube;smoothed??={years:runningMean(cube.years,cube.values[0]).years,values:cube.values.map(v=>runningMean(cube.years,v).values)};return smoothed}
function download(name,text){const url=URL.createObjectURL(new Blob([text],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
const preamble=()=>[`build_id=${meta.build_id}`,'SYNTHETIC DEMONSTRATION',`metric=${metricInfo().id}`,`scenario=${$('ssp').value}`,`timescale=${timescale()}`];

// Accessible SVG: a name and description that state what is plotted and the key reading.
function svg(content,h,id,title,desc){return `<svg viewBox="0 0 1100 ${h}" role="img" aria-labelledby="${id}-t ${id}-d"><title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>${content}</svg>`}
// Numeric table behind a chart, with CSV download. Keeps its open/closed state across redraws.
function dataPanel(id,title,columns,rows,filename){
 const el=$(id),open=el.querySelector('details')?.open,num=v=>typeof v==='number'?Math.round(v*100)/100:v;
 el.innerHTML=`<details class="data-panel"${open?' open':''}><summary>View data table · ${esc(title)}</summary><div class="table-wrap data-scroll"><table class="data"><caption class="sr">${esc(title)}</caption><thead><tr>${columns.map(c=>`<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${esc(num(v)??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div><button type="button">Download CSV</button></details>`;
 el.querySelector('button').onclick=()=>download(filename,toCsv(columns,rows,preamble()));
}
function polygon(rows,lo,hi,x,y){return rows.map(r=>`${x(r.year)},${y(hi(r))}`).concat([...rows].reverse().map(r=>`${x(r.year)},${y(lo(r))}`)).join(' ')}
function path(rows,value,x,y){return rows.map((r,i)=>`${i?'L':'M'}${x(r.year)},${y(value(r))}`).join(' ')}
function axes(x,y,low,high,h=280){let s='';for(let v=Math.ceil(low/20)*20;v<=high;v+=20)s+=`<line x1="65" x2="1070" y1="${y(v)}" y2="${y(v)}" stroke="#e8ede7"/><text x="52" y="${y(v)+4}" text-anchor="end">${v}${suffix()}</text>`;for(let year=2020;year<=2100;year+=20)s+=`<text x="${x(year)}" y="${h-10}" text-anchor="middle">${year}</text>`;return s}

// Scope badges say which panels respond to the slicers and which always describe the full scenario ensemble.
function setScopes(full,act){
 const n=act.length,sliced=n!==full.length,gcms=[...new Set(act.map(i=>chains[i].gcm))].join(', ')||'none';
 const live=`<b>${sliced?'Sliced':'All chains'}</b> · n = ${n} of ${full.length}`;
 for(const id of ['fan','breaches','futures'])$(`scope-${id}`).innerHTML=live+(id==='fan'?` · GCMs: ${esc(gcms)} · <a href="${chainHref}" target="_blank" rel="noopener">Chain list ↗</a> · ${esc(meta.build_id)}`:'');
 for(const id of ['shares','cascade'])$(`scope-${id}`).innerHTML=`<b>Full ensemble</b> · n = ${full.length} · slicers do not apply`;
 for(const id of ['fan','breaches','futures'])$(`scope-${id}`).className=`scope live${sliced?' on':''}`;
 for(const id of ['shares','cascade'])$(`scope-${id}`).className='scope full';
}
function drawChips(){
 $('chips').innerHTML=factors.filter(f=>$(`fix-${f}`).value!=='all').map(f=>`<button type="button" class="chip" data-factor="${f}" aria-label="Remove ${esc(factorLabel(f))} filter">${esc(factorLabel(f))}: ${esc($(`fix-${f}`).value)} ×</button>`).join('')||'<span class="muted">No sources held fixed</span>';
}
function legendItem(kind,color,label){return `<span><i class="sw ${kind}" style="${kind==='box'?`background:${color}`:`border-top-color:${color}`}"></i>${label}</span>`}

function redraw(){
 const start=performance.now(),scenario=$('ssp').value,h=Number($('horizon').value);
 const sel=selectChains(chains,scenario,fixedValues()),full=sel.full;active=sel.active;
 setScopes(full,active);drawChips();
 if(!active.length){$('status').textContent='No chains match these filters. Reset the slicers to restore the ensemble.';for(const id of ['fan','shares','breaches','cascade','futures'])$(id).innerHTML='No matching chains.';$('reading').textContent='';return}
 const filtered=fanRows(view(),active),fullFan=fanRows(view(),full),v=products.variance.filter(r=>r.year>=2020).sort((a,b)=>a.year-b.year),q=products.quantiles.filter(r=>r.year>=2020).sort((a,b)=>a.year-b.year);
 const threshold=Number($('threshold').value);
 if(isPct()&&(!Number.isFinite(threshold)||$('threshold').value==='')){$('status').textContent='Enter a finite runoff threshold.';return}
 const low=Math.floor(Math.min(isPct()?-40:Infinity,isPct()?threshold:Infinity,...fullFan.map(r=>r.p05),...q.map((r,i)=>r.mean-1.645*Math.sqrt(v[i].total)))/20)*20;
 const high=Math.ceil(Math.max(isPct()?20:-Infinity,isPct()?threshold:-Infinity,...fullFan.map(r=>r.p95),...q.map((r,i)=>r.mean+1.645*Math.sqrt(v[i].total)))/20)*20;
 const x=yr=>65+(Math.min(yr,2100)-2020)/80*1005,y=val=>240-(val-low)/(high-low)*210;
 const sliced=active.length!==full.length,partitioned=$('mode').value==='partitioned'&&!sliced;
 // Selected horizon: shaded on the fan, outlined on the shares chart.
 const band=`<rect x="${x(h)}" y="22" width="${x(h+10)-x(h)}" height="218" fill="#e3eddc"/><text x="${x(h)+4}" y="16" font-weight="650">${h}s selected</text>`;
 let s=axes(x,y,low,high)+band;
 s+=`<polygon points="${polygon(fullFan,r=>r.p10,r=>r.p90,x,y)}" fill="#dfe3df"/>`;
 if(partitioned){
  const order=['internal','hydro','bc','ds','gcm','ssp','interaction'];
  const bands=order.map((f,k)=>q.map((r,i)=>({...r,width:1.645*Math.sqrt(order.slice(0,k+1).reduce((sum,f)=>sum+v[i][f],0))})));
  for(let k=order.length-1;k>=0;k--)s+=`<polygon points="${polygon(bands[k],r=>r.mean-r.width,r=>r.mean+r.width,x,y)}" fill="${colors[order[k]]}" fill-opacity=".65"/>`;
 }else s+=`<polygon points="${polygon(filtered,r=>r.p10,r=>r.p90,x,y)}" fill="#4c8d77" fill-opacity=".6"/><path d="${path(filtered,r=>r.p50,x,y)}" fill="none" stroke="#235947" stroke-width="2"/>`;
 const meanRows=sliced?filtered:q;  // the mean must describe the chains that are drawn
 s+=`<path d="${path(meanRows,r=>r.mean,x,y)}" fill="none" stroke="#234c45" stroke-dasharray="6 4" stroke-width="1.7"/>`;
 const mismatch=q.some((r,i)=>Math.abs(2*1.645*Math.sqrt(v[i].total)-(r.p95-r.p05))/Math.max(r.p95-r.p05,1e-9)>.1);
 if(mismatch)for(const side of ['p05','p95'])s+=`<path d="${path(q,r=>r[side],x,y)}" fill="none" stroke="#606b66" stroke-dasharray="2 4"/>`;
 if(isPct())s+=`<line x1="65" x2="1070" y1="${y(threshold)}" y2="${y(threshold)}" stroke="#a36143" stroke-dasharray="7 4"/><text x="1066" y="${y(threshold)-5}" text-anchor="end">Threshold ${threshold}%</text>`;
 const reading=describeFan(filtered,h,timescale()),fmt=val=>`${val.toFixed(1)}${suffix()}`;
 const readText=reading?`${scenarioLabel()}, ${h}s: median ${fmt(reading.median)}, P10–P90 ${fmt(reading.p10)} to ${fmt(reading.p90)} across ${active.length} of ${full.length} chains (${scaleLabel()}, ${metricInfo().units}).`:'';
 $('reading').textContent=readText;
 $('fan').innerHTML=svg(s,280,'fan-svg','Uncertainty fan of future runoff',`${readText} Chart of ${metricInfo().name.toLowerCase()} from 2020 to 2100: grey band is all chains in the scenario, green band the selected chains, dashed line their mean.${isPct()?` Dashed horizontal line marks the ${threshold}% screening threshold.`:''} Numbers are in the data table below.`);
 $('fan-legend').innerHTML=[legendItem('box','#dfe3df','All chains in scenario, P10–P90'),
  partitioned?legendItem('box','#708bad','Normal-approximation 90% bands (colours: variance sources, below)'):legendItem('box','#4c8d77',`${sliced?'Selected chains':'Chains'} P10–P90`)+legendItem('line','#235947','Median'),
  legendItem('dash','#234c45',sliced?'Mean of selected chains':'Ensemble-mean response'),
  mismatch?legendItem('dot','#606b66','Empirical P05–P95 (shown when widths disagree)'):'',
  isPct()?legendItem('dash','#a36143','Screening threshold'):'',
  legendItem('box','#e3eddc',`Selected horizon (${h}s)`)].join('');
 dataPanel('fan-data',`fan, ${scenarioLabel()}, ${scaleLabel()}`,['year','p05','p10','p50','p90','p95','mean of selected chains'],filtered.map(r=>[r.year,r.p05,r.p10,r.p50,r.p90,r.p95,r.mean]),`${meta.build_id}-fan.csv`);
 $('normalisation').textContent=isPct()?'Each chain is expressed relative to its own 1990–2019 mean, so baseline differences between chains are removed.':`Absolute values keep baseline differences between chains. 1990–2019 mean across chains: P10 ${meta.baseline_spread_abs.p10.toFixed(1)} · P50 ${meta.baseline_spread_abs.p50.toFixed(1)} · P90 ${meta.baseline_spread_abs.p90.toFixed(1)} (${metricInfo().units}).`;
 $('agreement').textContent=`Timescale: ${scaleLabel()} (fan, share and cascade values; breach rules stay annual). ${sliced?'Slicers active: showing the empirical fan of the selected chains; the variance shares and cascade describe the full scenario ensemble. ':''}${mismatch?'Width flag: empirical P05–P95 and normal-approximation 90% widths differ by over 10%; dotted empirical limits shown.':'Empirical and normal-approximation 90% widths agree within 10%.'} ${scenario==='all'?'All scenarios pooled with equal design counts; SSPs have no assigned probabilities.':''}`;
 let area='',cumulative=v.map(()=>0);
 for(const f of Object.keys(colors)){const rows=v.map((r,i)=>{const lo=cumulative[i],hi=lo+(comp(r)?100*r[f]/comp(r):0);cumulative[i]=hi;return {year:r.year,lo,hi}});area+=`<polygon points="${polygon(rows,r=>r.lo,r=>r.hi,x,z=>110-z)}" fill="${colors[f]}"/>`}
 area+=`<line x1="${x(h)}" x2="${x(h)}" y1="0" y2="112" stroke="#163c3b" stroke-dasharray="3 3"/><line x1="${x(h+10)}" x2="${x(h+10)}" y1="0" y2="112" stroke="#163c3b" stroke-dasharray="3 3"/>`;
 area+=`<text x="52" y="18" text-anchor="end">100%</text><text x="52" y="113" text-anchor="end">0%</text><text x="65" y="138">Fraction of attributed variance · full scenario ensemble · ${scaleLabel()} · ${h}s outlined</text>`;
 const hs=headlineShares(products.variance,Object.keys(colors),h,timescale());
 $('shares').innerHTML=svg(area,150,'shares-svg','Variance shares by source over time',`Stacked areas, 0 to 100% of attributed variance, 2020 to 2100, ${scaleLabel()}. In the ${h}s: climate ${hs.climate.toFixed(0)}%, hydrological parameters ${hs.hydro.toFixed(0)}%, internal variability ${hs.internal.toFixed(0)}%, interactions ${hs.interaction.toFixed(0)}%.`);
 dataPanel('shares-data',`variance shares, ${scenarioLabel()}, ${scaleLabel()}`,['year',...Object.keys(colors).map(f=>`${names[f]} %`)],v.map(r=>[r.year,...Object.keys(colors).map(f=>comp(r)?100*r[f]/comp(r):0)]),`${meta.build_id}-variance-shares.csv`);
 drawCascade();drawBreaches(threshold);drawFutures();
 $('status').textContent=`${active.length} chains selected · local redraw ${(performance.now()-start).toFixed(0)} ms · ${scenario==='all'?'pooled scenarios':scenario}`;
}
function drawCascade(){
 const rows=[...products.cascade].sort((a,b)=>a.order-b.order),h=Number($('horizon').value);
 const hv=horizonRows(products.variance,h,timescale()),total=mean(hv.map(comp));
 const shares=Object.fromEntries(Object.keys(colors).map(f=>[f,total?100*mean(hv.map(r=>r[f]))/total:0]));
 const point=headlineShares(products.variance,Object.keys(colors),h,timescale());
 const groups=[['climate','Climate'],['hydro','Hydrological parameters'],['internal','Internal variability'],['interaction','Interactions']];
 const range=g=>{const x=products.sensitivity.map(r=>r['share_'+g]).concat(point[g]);return `${Math.floor(Math.min(...x))}–${Math.ceil(Math.max(...x))}`};
 $('headline').textContent=groups.map(([g,label])=>`${label} ${point[g].toFixed(0)}% (${range(g)}%)`).join(' · ')+` · ${scaleLabel()}`;
 const boot=products.bootstrap[0],estimators=[...new Set(products.sensitivity.map(r=>r.estimator))];
 $('headline').title=`Ranges: lowest to highest share across ${estimators.length} response estimators (${estimators.join(', ')}). `+(boot?`GCM bootstrap 90% interval (${boot.draws} draws, ${boot.gcm_count} GCMs): `+groups.map(([g,label])=>`${label} ${boot[g+'_p05'].toFixed(0)}–${boot[g+'_p95'].toFixed(0)}%`).join('; ')+'.':'');
 const lo=Math.min(...rows.map(r=>r.p10)),hi=Math.max(...rows.map(r=>r.p90)),scale=z=>165-(z-lo)/Math.max(hi-lo,1)*125;
 let s='';rows.forEach((r,i)=>{const cx=95+i*180,ny=rows[i+1];if(ny)s+=`<polygon points="${cx},${scale(r.p10)} ${cx+180},${scale(ny.p10)} ${cx+180},${scale(ny.p90)} ${cx},${scale(r.p90)}" fill="${colors[r.stage]}" fill-opacity=".7"/>`;s+=`<line x1="${cx}" x2="${cx}" y1="${scale(r.p10)}" y2="${scale(r.p90)}" stroke="${colors[r.stage]}" stroke-width="3"/><circle cx="${cx}" cy="${scale(r.p50)}" r="3" fill="#254b40"/><text x="${cx}" y="195" text-anchor="middle">${names[r.stage]}</text><text x="${cx}" y="215" text-anchor="middle">${shares[r.stage].toFixed(1)}% · [${r.p10.toFixed(0)}, ${r.p90.toFixed(0)}]${suffix()}</text>`});
 const last=rows[rows.length-1];
 $('cascade').innerHTML=svg(s,235,'cascade-svg','Cascade of uncertainty sources',`P10–P90 envelope of the ${h}s response widening through ${rows.length} stages from ${rows[0].p10.toFixed(0)} to ${rows[0].p90.toFixed(0)}${suffix()} after scenario spread to ${last.p10.toFixed(0)} to ${last.p90.toFixed(0)}${suffix()} after internal variability. ${$('headline').textContent}.`);
 dataPanel('cascade-data',`cascade, ${h}s, ${scenarioLabel()}, ${scaleLabel()}`,['stage','p10','p50','p90','share of variance %'],rows.map(r=>[names[r.stage],r.p10,r.p50,r.p90,shares[r.stage]]),`${meta.build_id}-cascade.csv`);
}
function drawBreaches(threshold){
 if(!isPct()){$('breaches').textContent='Breach screening uses the percentage-change metric. Switch the metric to "Annual runoff · change" to score thresholds.';$('rule-label').textContent='';$('breaches-data').innerHTML='';return}
 const rule=$('rule').value,n=Number($('persistent').value),h=Number($('horizon').value);$('persistent').disabled=!['dry_years_per_decade','consecutive_run'].includes(rule);
 if(!$('persistent').disabled&&(!Number.isInteger(n)||n<1||n>10)){$('breaches').textContent='Dry-year count must be an integer from 1 to 10.';return}
 $('rule-label').textContent=`${rule==='annual'?'Annual: chain-years':rule==='dry_years_per_decade'?`At least ${n} dry years per decade: chains with ≥ ${n} years`:rule==='consecutive_run'?`At least ${n} consecutive dry years: chains with a run ≥ ${n} years`:'Decadal mean: chains with mean'} below ${threshold}% change in each decade.`;
 const cells=breachGrid(cube,chains,active,meta.levels.ssp,decades,threshold,rule,n),unit=rule==='annual'?'chain-years':'chains';
 let html='<table><thead><tr><th>Scenario</th>'+decades.map(d=>`<th${d===h?' class="sel-col" aria-current="true"':''}>${d}s${d===h?' ◂ selected':''}</th>`).join('')+'</tr></thead><tbody>';
 for(const scenario of meta.levels.ssp){html+=`<tr><th>${esc(scenario)}</th>`;for(const d of decades){const c=cells.find(k=>k.scenario===scenario&&k.decade===d),cls=d===h?' class="sel-col"':'';html+=c.share===null?`<td${cls}>—<small>n = 0</small></td>`:`<td${cls} style="background:rgba(177,105,64,${.05+c.share*.55})">${(c.share*100).toFixed(0)}%<small>${c.count} / ${c.denominator} ${unit}<br>n = ${c.n_chains}</small></td>`}html+='</tr>'}
 $('breaches').innerHTML=html+'</tbody></table>';
 dataPanel('breaches-data',`breach shares, ${rule}, threshold ${threshold}%`,['scenario','decade','breaches','denominator',`denominator unit`,'share %','chains'],cells.map(c=>[c.scenario,c.decade,c.count,c.denominator,unit,c.share===null?null:c.share*100,c.n_chains]),`${meta.build_id}-breaches.csv`);
}
function drawFutures(){const included=new Set(active.map(i=>chains[i].gcm));const classes=['Much drier','Drier','Little change','Wetter'];let html='';for(const ssp of meta.levels.ssp){if($('ssp').value!=='all'&&$('ssp').value!==ssp)continue;const rows=products.futures.filter(r=>r.ssp===ssp);html+=`<h4>${ssp}</h4><div class="table-wrap"><table><thead><tr><th>Temperature / Rainfall</th>${classes.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>`;for(const t of ['Warmer','Hotter','Much hotter']){html+=`<tr><th>${t}</th>`;for(const p of classes){const cell=rows.filter(r=>r.temperature_class===t&&r.rainfall_class===p);const n=cell.filter(r=>included.has(r.gcm)).length;html+=`<td style="background:${n?'#dfebd9':'#f2f4f0'}">${cell.length} / ${rows.length} models<small>${n} included${cell.length?'<br>'+cell.map(r=>r.gcm).join('<br>'):''}</small></td>`}html+='</tr>'}html+='</tbody></table></div>'} $('futures').innerHTML=html}
async function refresh(){const version=++generation;$('status').textContent='Reading versioned products…';try{await ensureCube();if(version!==generation)return;const ssp=encodeURIComponent($('ssp').value),h=$('horizon').value,b=base();const responses=await Promise.all([get(`/variance?${b}&ssp=${ssp}&timescale=${timescale()}`),get(`/quantiles?${b}&ssp=${ssp}&timescale=${timescale()}`),get(`/cascade?${b}&ssp=${ssp}&horizon=${h}&timescale=${timescale()}`),get(`/sensitivity?${b}&ssp=${ssp}&horizon=${h}&timescale=${timescale()}`),get(`/bootstrap?${b}&ssp=${ssp}&horizon=${h}&timescale=${timescale()}`),...meta.levels.ssp.map(s=>get(`/futures?horizon=${h}&ssp=${encodeURIComponent(s)}`))]);if(version!==generation)return;if(responses.some(r=>r.build_id!==meta.build_id))throw Error('Product release changed. Reload the page.');products={variance:responses[0].data.map(r=>({...r,...Object.fromEntries(Object.entries(r).filter(([k])=>k.startsWith("var_")).map(([k,v])=>[k.slice(4),v]))})),quantiles:responses[1].data,cascade:responses[2].data,sensitivity:responses[3].data,bootstrap:responses[4].data,futures:responses.slice(5).flatMap(r=>r.data)};redraw()}catch(e){$('status').textContent=`Unable to load products: ${e.message}`}}
function reset(){factors.forEach(f=>$(`fix-${f}`).value='all')}
async function init(){try{document.querySelectorAll('[data-chain-catalogue]').forEach(a=>a.href=chainHref);meta=await get('/metadata');$('metric').innerHTML=meta.metrics.map(m=>`<option value="${m.id}">${esc(m.name)} · ${esc(m.units)}</option>`).join('');const [chainResponse,cubeResponse]=await Promise.all([get('/chains'),get(`/cube?${base()}&format=json`)]);if(chainResponse.build_id!==meta.build_id||cubeResponse.build_id!==meta.build_id)throw Error('Inconsistent product release');chains=chainResponse.data;cube=cubes[$('metric').value]=cubeResponse.data;
 $('release').innerHTML=`${meta.n_chains} ensemble chains<br>3 scenarios · 3 GCMs<br>Baseline: ${esc(meta.baseline)}`;$('build').textContent=meta.build_id;
 $('legend').innerHTML=Object.keys(colors).map(f=>legendItem('box',colors[f],names[f])).join('');
 $('slicers').innerHTML=factors.map(f=>`<label>${factorLabel(f)}<select id="fix-${f}"><option value="all">All levels</option>${meta.levels[f].map(l=>`<option>${esc(l)}</option>`).join('')}</select></label>`).join('');
 $('provenance').textContent=`${meta.build_id} · ${meta.weighting}. ${meta.smoothing}. All chain provenance is synthetic. Variance shares are shown with their range across response estimators; GCM-bootstrap intervals (three GCMs) are wide. Historical and calibration gates have not passed.`;
 $('qa').textContent=JSON.stringify(meta.qa,null,2);
 for(const id of ['ssp','horizon','node','metric','timescale'])$(id).addEventListener('change',refresh);
 for(const id of ['mode','threshold','rule','persistent',...factors.map(f=>`fix-${f}`)])$(id).addEventListener('change',()=>products&&redraw());
 $('chips').addEventListener('click',e=>{const b=e.target.closest('[data-factor]');if(b){$(`fix-${b.dataset.factor}`).value='all';redraw()}});
 $('reset').onclick=()=>{reset();redraw()};$('climate').onclick=()=>{reset();$('fix-hydro').value='P03';redraw()};$('hydrology').onclick=()=>{reset();$('ssp').value='SSP2-4.5';for(const f of ['gcm','ds','bc','member'])$(`fix-${f}`).value=meta.levels[f][0];refresh()};
 $('export').onclick=()=>{const rows=[];for(const i of active)cube.years.forEach((year,j)=>rows.push([chains[i].chain_id,...Object.keys(meta.levels).map(f=>chains[i][f]),year,cube.values[i][j]]));download(`${meta.build_id}-filtered.csv`,toCsv(['chain_id','ssp','gcm','ds','bc','hydro','member','year',isPct()?'delta_percent':'value'],rows,[`build_id=${meta.build_id}`,'SYNTHETIC',meta.baseline]))};
 await refresh();}catch(e){$('status').textContent=`Startup failed: ${e.message}`}}
init();
