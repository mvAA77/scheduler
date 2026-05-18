export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          error: "Method not allowed. Use POST."
        })
      };
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          error: "Missing GEMINI_API_KEY environment variable."
        })
      };
    }

    const body = JSON.parse(event.body || "{}");

    const {
      taskInput,
      schedule,
      days,
      startHour,
      endHour
    } = body;

    if (!taskInput || !schedule || !days) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          error: "Missing taskInput, schedule, or days in request body."
        })
      };
    }

    const freeSlots = getFreeSlots({
      schedule,
      days,
      startHour,
      endHour,
      duration: Number(taskInput.duration),
      dueDate: taskInput.dueDate
    });

    if (freeSlots.length === 0) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          dayIndex: null,
          startHour: null,
          reason: "No free slots are available before the due date."
        })
      };
    }

    const prompt = `
You are a smart weekly scheduling assistant.

Task:
${JSON.stringify(taskInput, null, 2)}

Available free slots:
${JSON.stringify(freeSlots, null, 2)}

Day index meaning:
0 = Monday
1 = Tuesday
2 = Wednesday
3 = Thursday
4 = Friday
5 = Saturday
6 = Sunday

Your job:
Pick the best available free slot.

Rules:
1. You must choose only from the available free slots list.
2. Do not invent a new time.
3. High priority tasks should be scheduled earlier.
4. Prefer productive hours between 9 AM and 8 PM.
5. Avoid very late night or very early morning times.
6. If the task is high priority, schedule it sooner.
7. Return only valid JSON.
8. Do not include markdown.
9. Do not include text outside the JSON.

Return exactly this JSON shape:
{
  "dayIndex": 2,
  "startHour": 16,
  "reason": "Short reason"
}
`;

    const geminiUrl =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ]
      })
    });

    const geminiText = await geminiResponse.text();

    console.log("Gemini status:", geminiResponse.status);
    console.log("Gemini raw response:", geminiText);

    if (!geminiResponse.ok) {
      throw new Error("Gemini API error: " + geminiText);
    }

    const geminiData = JSON.parse(geminiText);

    const modelText =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!modelText) {
      throw new Error("Gemini returned no text: " + geminiText);
    }

    const jsonMatch = modelText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error("Gemini did not return JSON: " + modelText);
    }

    const result = JSON.parse(jsonMatch[0]);

    const validSlot = freeSlots.some(slot => {
      return (
        slot.dayIndex === result.dayIndex &&
        slot.startHour === result.startHour
      );
    });

    if (!validSlot) {
      const backup = freeSlots[0];

      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          dayIndex: backup.dayIndex,
          startHour: backup.startHour,
          reason: "Gemini returned an invalid slot, so the first available free slot was used."
        })
      };
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        dayIndex: result.dayIndex,
        startHour: result.startHour,
        reason: result.reason || "Scheduled by Gemini."
      })
    };
  } catch (error) {
    console.error("Function error:", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        error: error.message
      })
    };
  }
}

function getFreeSlots({
  schedule,
  days,
  startHour,
  endHour,
  duration,
  dueDate
}) {
  const dueDayIndex = getDueDayIndex(dueDate);
  const freeSlots = [];

  for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
    if (dayIndex > dueDayIndex) continue;

    for (let hour = startHour; hour <= endHour - duration + 1; hour++) {
      if (isBlockFree(schedule, dayIndex, hour, duration)) {
        freeSlots.push({
          dayIndex,
          day: days[dayIndex],
          startHour: hour,
          endHour: hour + duration,
          label: `${days[dayIndex]} ${formatHour(hour)} - ${formatHour(hour + duration)}`
        });
      }
    }
  }

  freeSlots.sort((a, b) => {
    if (a.dayIndex !== b.dayIndex) {
      return a.dayIndex - b.dayIndex;
    }

    return a.startHour - b.startHour;
  });

  return freeSlots;
}

function isBlockFree(schedule, dayIndex, start, duration) {
  for (let hour = start; hour < start + duration; hour++) {
    const key = `${dayIndex}-${hour}`;

    if (schedule.busy && schedule.busy[key]) {
      return false;
    }

    const overlappingTask = (schedule.tasks || []).some(task => {
      if (task.dayIndex !== dayIndex) return false;

      const taskStart = task.startHour;
      const taskEnd = task.startHour + task.duration;

      return hour >= taskStart && hour < taskEnd;
    });

    if (overlappingTask) {
      return false;
    }
  }

  return true;
}

function getDueDayIndex(dateString) {
  const date = new Date(dateString + "T12:00:00");
  const jsDay = date.getDay();

  return jsDay === 0 ? 6 : jsDay - 1;
}

function formatHour(hour) {
  const normalizedHour = hour % 24;
  const suffix = normalizedHour >= 12 ? "PM" : "AM";
  const h = normalizedHour % 12 || 12;

  return `${h}:00 ${suffix}`;
}
