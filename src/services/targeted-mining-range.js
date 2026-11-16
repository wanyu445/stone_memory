function targetedMessageMatches(rows,{search='',startTime='',endTime=''}={}) {
 for(const time of [startTime,endTime])if(time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new Error('时间格式无效');
 if(startTime&&endTime&&startTime>=endTime)throw new Error('终点须晚于起点');
 const needle=search.trim().toLocaleLowerCase();
 const mapped=rows.map(row=>{
  const parsed=Date.parse(row.timestamp);
  const time=Number.isFinite(parsed)?new Date(parsed+8*3600000).toISOString().slice(11,16):null;
  return {...row,matched:(!needle||row.text.toLocaleLowerCase().includes(needle))&&(!(startTime||endTime)||(time!==null&&(!startTime||time>=startTime)&&(!endTime||time<endTime)))};
 });
 return {rows:mapped,matchCount:mapped.filter(row=>row.matched).length,timeZone:'Asia/Shanghai'};
}
module.exports={targetedMessageMatches};
