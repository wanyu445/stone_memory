function number(output, pattern) {
  const match=String(output||"").match(pattern);
  return match?Number(String(match[1]).replace(/,/g,"")):null;
}

function parseRebuildDryRun(output) {
  const text=String(output||"");
  const runtime=/\[codex-rebuild\]/.test(text)?"codex":"claude";
  const windowMatch=text.match(/Window:\s*(\d+)\s*days\s*\((?:cutoff:|since)\s*([^)]+)\)/i);
  const watermarkMatch=text.match(/Retention mode:\s*watermark\s*\(feeling\s+([^,]+),\s*since\s+([^)]+)\)/i);
  const watermarkFallback=/Retention mode:\s*active-days\s*\(watermark unavailable\)/i.test(text);
  const originalOutput=text.match(/Original(?: messages)?:\s*(\d+)(?:\s*lines)?(?:\s*→\s*Output:\s*(\d+)\s*lines)?/i);
  const outputLines=number(text,/Output lines:\s*(\d+)/i)??(originalOutput?.[2]?Number(originalOutput[2]):null);
  const toolMatch=text.match(/tool chains?:\s*(\d+)\s*pairs(?:,\s*(\d+)\s*tool IDs)?/i);
  const splitMatch=text.match(/(\d+)\s*pre-window,\s*(\d+)\s*in-window/i);
  const retainMatch=text.match(/(\d+)\s*(?:retainOriginal|fragments).*?(?:→\s*(\d+)\s*fragments,\s*)?(\d+)\s*(?:archive\s*)?dates/i);
  const codexStats=text.match(/Memory blocks:\s*(\d+)\s*\|\s*(?:Recent window messages|Messages):\s*(\d+)\s*\|\s*Function calls:\s*(\d+)/i);
  const retainedMessages=number(text,/Retained messages:\s*(\d+)/i)??0;
  const explicitRecentMessages=number(text,/Recent window messages:\s*(\d+)/i);
  const legacyWindowMessages=codexStats?Number(codexStats[2]):number(text,/Window messages:\s*(\d+)/i);
  const injectableFeelings=number(text,/Loading injectable feelings[\s\S]*?\n[^\n]*?(\d+)\s+feelings/i)
    ??(splitMatch?Number(splitMatch[1])+Number(splitMatch[2]):null);
  const summarySelection=text.match(/Summary selection:\s*(\d+)\s+candidates\s*→\s*(\d+)\s+selected\s*\(latest=([^,]+),\s*minImportance=(\d+),\s*protected=(\d+),\s*overflow=(\d+)\)/i);
  return {
    runtime,
    windowDays:windowMatch?Number(windowMatch[1]):null,
    cutoff:windowMatch?.[2]?.trim()||null,
    retentionMode:watermarkMatch?"watermark":"active-days",
    watermarkFeelingId:watermarkMatch?.[1]?.trim()||null,
    watermarkCutoff:watermarkMatch?.[2]?.trim()||null,
    watermarkFallback,
    fullMessages:number(text,/(\d+)\s+messages from full/i),
    injectableFeelings,
    summaryCandidates:summarySelection?Number(summarySelection[1]):null,
    selectedSummaries:summarySelection?Number(summarySelection[2]):null,
    summaryLimit:summarySelection&&summarySelection[3]!=="all"?Number(summarySelection[3]):null,
    minImportance:summarySelection?Number(summarySelection[4]):0,
    protectedSummaries:summarySelection?Number(summarySelection[5]):null,
    protectedOverflow:summarySelection?Number(summarySelection[6]):0,
    preWindowFeelings:splitMatch?Number(splitMatch[1]):null,
    inWindowFeelings:splitMatch?Number(splitMatch[2]):null,
    retainAnchors:retainMatch?Number(retainMatch[1]):null,
    retainFragments:retainMatch?.[2]?Number(retainMatch[2]):(retainMatch?Number(retainMatch[1]):null),
    retainDates:retainMatch?Number(retainMatch[3]):null,
    injectedRules:number(text,/injected\s+(\d+)\s+rules/i),
    toolPairs:toolMatch?Number(toolMatch[1]):number(text,/Tool pairs preserved:\s*(\d+)/i),
    toolIds:toolMatch?.[2]?Number(toolMatch[2]):null,
    originalMessages:originalOutput?Number(originalOutput[1]):null,
    outputLines,
    reductionPercent:number(text,/Reduction:\s*([\d.]+)%/i),
    memoryBlocks:codexStats?Number(codexStats[1]):number(text,/Memory blocks:\s*(\d+)/i),
    // Older dry-runs included retained anchor fragments in the window count.
    // Prefer the explicit new field; correct legacy output by subtracting the
    // separately reported retained count.
    windowMessages:explicitRecentMessages??(legacyWindowMessages===null?null:Math.max(0,legacyWindowMessages-retainedMessages)),
    retainedMessages,
    functionCalls:codexStats?Number(codexStats[3]):null,
    systemDropped:number(text,/System dropped:\s*(\d+)/i),
    memoryFeelings:number(text,/Memory feelings:\s*(\d+)/i),
    fullArchiveBytes:number(text,/Full archive size:\s*(\d+)\s*bytes/i),
    estimatedOutputBytes:number(text,/Estimated output:\s*(\d+)\s*bytes/i),
    raw:text,
  };
}

module.exports={parseRebuildDryRun};
