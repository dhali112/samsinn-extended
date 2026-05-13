---
procedure-md: 0.7
procedure-id: FEAT-WITHIN
title: Within keyword feature fixture
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
category: diagnostic-eop
csfs-monitored: []
entry-triggers: []
---

## Step 1 [id: trip-rcps]
Check: subcooling «SUB-MARGIN» < 30 °F
Within: 60 s
Action: trip all four RCPs

## Tags

- id: SUB-MARGIN
  description: RCS subcooling margin
  sim-path: rcs.subcooling
  units: degF
  equipment: rcs
