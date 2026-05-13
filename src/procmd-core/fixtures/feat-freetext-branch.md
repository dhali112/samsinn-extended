---
procedure-md: 0.7
procedure-id: FEAT-FREETEXT
title: free text branch target feature fixture
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
category: diagnostic-eop
csfs-monitored: []
entry-triggers: []
---

## Step 1 [id: assess]
Check: containment radiation is rising
- yes → free text: enter SAMG entry conditions
- no → #continue

## Step 2 [id: continue]
Action: continue normal recovery
