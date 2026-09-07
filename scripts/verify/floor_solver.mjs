import assert from 'node:assert/strict';
import {partitionOrderedCut} from '../preprocess/floors/ordered_cut.mjs';

function graph(count, edges) {
  const nodes=Array.from({length:count},(_,band)=>({band,area:10,edges:new Set(),pieces:[]}));
  for(const [a,b]of edges){nodes[a].edges.add(b);nodes[b].edges.add(a);}
  return {nodes,base:0,step:1,edgeCosts:new Map(edges.map(([a,b,c])=>[a+':'+b,c]))};
}
function check(count,edges,relations) {
  const g=graph(count,edges),o={relations:new Map(relations.map(([a,b])=>[a+':'+b,1])),stats:{}};
  const p=partitionOrderedCut(g,o),floors=Math.max(p.stats.minimumFloors||1,p.stats.baselineFloors||1);
  let best=Infinity;
  for(let state=0;state<floors**count;state++){
    let code=state;const labels=Array.from({length:count},()=>{const label=code%floors;code=Math.floor(code/floors);return label;});
    if(edges.some(([a,b])=>labels[a]>labels[b])||relations.some(([a,b])=>labels[a]>=labels[b]))continue;
    const cost=edges.reduce((sum,[a,b,w])=>sum+w*Math.abs(labels[a]-labels[b]),0);best=Math.min(best,cost);
  }
  const cost=edges.reduce((sum,[a,b,w])=>sum+w*Math.abs(p.labels[a]-p.labels[b]),0);
  assert.equal(cost,best);return p;
}

const ramp=check(5,[[0,1,2],[1,2,3],[2,3,3],[3,4,2]],[[0,2],[1,4],[0,4]]);
assert.deepEqual([...ramp.labels],[0,0,1,1,1]);
for(let i=0;i<8;i++)check(4,[[0,1,1+i],[1,2,8-i],[2,3,2+i]],[[0,2],[1,3],...(i%2?[[0,3]]:[])]);
console.log(JSON.stringify({passed:9,bruteForceOptimum:true,transitionLabels:[...ramp.labels]}));
