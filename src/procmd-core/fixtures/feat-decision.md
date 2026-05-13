---
procedure-md: 0.7
procedure-id: FEAT-DECISION
title: Decision keyword feature fixture
profile: nuclear-erg
applies-to: Westinghouse-style 4-loop PWR
category: diagnostic-eop
csfs-monitored: []
entry-triggers: []
---

## Step 1 [id: classify-event, decision]
Decision: classify the event by symptom pattern
- LOCA-symptoms → [[FEAT-DECISION-LOCA]]
  Because: HHSI flow + falling pressurizer level
- SGTR-symptoms → [[FEAT-DECISION-SGTR]]
  Because: rising SG level on one loop
- transient → #recovery
  Against: no inventory loss signal

## Step 2 [id: recovery]
Action: stabilize per normal post-trip flow
