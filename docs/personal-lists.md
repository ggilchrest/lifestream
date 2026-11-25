# Personal lists and reminder displays

Use the conversation room or iPhone text chat in a signed-in personal session. The host saves items under the authenticated principal. A new chat or a second sign-in for that principal reads the same SQLite records.

## Chat commands

| Intent | Example |
| --- | --- |
| Create or show a list | `Create a hardware list` or `Show my hardware list` |
| Change an item | `Add hinges to my hardware list`, then `Edit hinges to brass hinges` |
| Complete or reopen | `Mark brass hinges done` or `Reopen brass hinges` |
| Read open work | `What's left?` or `What's left on my hardware list?` |
| Set a time | `Remind me at 4 PM to check the finish` |
| Set a place | `Remind me to check the finish next time I am in the shop` |
| Set a departure cue | `Remind me to collect a parcel next time I leave home` |
| Change the trigger | `Reschedule check the finish to 5 PM` or `Reschedule check the finish to next time in the shop` |
| Snooze or cancel | `Snooze check the finish for 10 minutes` or `Cancel check the finish` |

An unspecified cue opens a picker when the host has no matching inference. Time requests use the submitting client's IANA time zone. A host with a trusted per-turn speaker verifier can execute a spoken operation for the verified account and speak the saved result. A committed speech transcript from an unidentified speaker goes into the personal chat draft for review and submission. Existing text in the draft takes precedence.

The server streams both a text reply and an A2UI v0.8 surface. Desktop and mobile share the local renderer. Button actions carry the saved item ID and revision. [Google A2UI v0.8 wire schema](https://github.com/google/A2UI/blob/main/specification/v0_8/json/server_to_client_with_standard_catalog.json)

## Host configuration

The candidate launcher accepts `--reminders PATH` for a deployment-owned JSON file outside Git. Use `displays` to bind existing logical endpoint IDs and `people` to bind published PWCE person projections. The launcher reads the selected profile's PWCE credential reference. Keep binding files and credentials local.

A synthetic example of the file shape follows. Replace identifiers with the deployment's authorized values. The zone mapping translates the published property value into the place name used in chat. The optional home-state mapping explicitly identifies values that establish home or away.

```json
{
  "displays": [
    {
      "owner": "synthetic-principal",
      "assistantId": "synthetic-assistant",
      "endpointId": "synthetic-wall-endpoint",
      "place": "shop",
      "personal": false,
      "fallback": false
    }
  ],
  "people": [
    {
      "owner": "synthetic-principal",
      "person": "person.one",
      "property": "qualified-zone",
      "site": "site.one",
      "maxAgeMs": 30000,
      "zones": {"zone.workshop": "shop", "zone.outside": "outside"},
      "homeStates": {"zone.workshop": "home", "zone.outside": "away"},
      "identity": {
        "assistantRef": "assistant.one",
        "endpointRef": "scheduler.one",
        "participantRefs": ["participant.one"],
        "audienceRef": "audience.one"
      }
    }
  ]
}
```

The display runs the conversation room signed in as the bound principal, with the configured Assistant selected. Its authenticated polling establishes reachability while the room is visible. The host rechecks the session and audience on reads and receipts. A protected display can receive a generic card. Opening a private session permits item details and controls. The scheduler stays on the host when the authoring chat closes. With no reachable approved destination, the record stays pending.

A renderer receipt records delivery for the exact item revision. Done on a delivered reminder separately records acknowledgment. A lost receipt retries the same delivery key. Rescheduling changes the revision and fences the old action.

## Device qualification

Use a controlled host clock and synthetic PWCE and display bindings for source verification. Physical qualification requires checking wall visibility and privacy transitions, reconnecting after a lost receipt, speech draft review, and a fresh cross-device sign-in. Native iPhone build and installation follow the repository iOS build checklist, including the approved asset and audio checks.
