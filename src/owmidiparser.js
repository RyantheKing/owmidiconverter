/*
Reads a MIDI object created by Tonejs/Midi and converts it to an Overwatch workshop array.
*/


"use strict";

// Range of notes on the overwatch piano, 
// based on the MIDI scale (0 - 127).
// One integer is one semitone.
const PIANO_RANGE = Object.freeze({
    MIN: 24,
    MAX: 88
});
const OCTAVE = 12;

/* Settings for the converter.
    - startTime: time (seconds) in the midi file when this script begins reading the data
    - voices: amount of bots required to play the resulting script, maximum amount of pitches allowed in any chord.
              At least 6 recommended to make sure all songs play back reasonably well
*/
const CONVERTER_SETTINGS_INFO = Object.freeze({
    startTime:	{MIN:0, MAX:Infinity,   DEFAULT:0},
    voices:		{MIN:6, MAX:11,         DEFAULT:6},
});

const DEFAULT_SETTINGS = {
    startTime:	CONVERTER_SETTINGS_INFO["startTime"]["DEFAULT"],
    voices:		CONVERTER_SETTINGS_INFO["voices"]["DEFAULT"],
};

// Maximum amount of elements in a single array of the song data rules.
// Overwatch arrays are limited to 999 elements per dimension.
const MAX_OW_ARRAY_SIZE = 999;

// The workshop script has a maximum Total Element Count (TEC) of 20 000, 
// which depends on not just the amount of rules and actions but also their complexity.
// This value is the maximum amount of *array* elements (not related to TEC) allowed in all song data rules.
// Determined with trial and error, and contains some leeway for adding more actions to the base script later on.
const MAX_TOTAL_ARRAY_ELEMENTS = 9000;

// Amount of decimals in the time of each note
const NOTE_PRECISION = 3;

const CONVERTER_WARNINGS = {
    TYPE_0_FILE: "WARNING: The processed file is a type 0 file and may have been converted incorrectly.\n"
};

const CONVERTER_ERRORS = {
    NO_NOTES_FOUND: `Error: no notes found in MIDI file in the given time range.\n`
};


function convertMidi(mid, settings={}) {
    /*
    param mid:  a Midi object created by Tonejs/Midi
    param settings: a JS object containing user parameters for 
                    parsing the midi data, see DEFAULT_SETTINGS for an example

    Return: a JS object, containing:
        string rules:           Overwatch workshop rules containing the song Data,
                                or an empty string if an error occurred
        int transposedNotes:    Amount of notes transposed to the range of the Overwatch piano
        int skippedNotes:       Amount of notes skipped due to there being too many pitches in a chord
        int totalElements:      Total amount of elements in the song data arrays of the workshop script
        float duration:         Full duration (seconds) of the MIDI song 
        float stopTime:         The time (seconds) when the script stopped reading the MIDI file, 
                                either due to finishing the song or due to reaching the maximum allowed amount of data 
        string[] warnings:      An array containing warnings output by the script
        string[] errors:        An array containing errors output by the script
    */

    if (Object.keys(settings).length != Object.keys(CONVERTER_SETTINGS_INFO).length) {
        settings = DEFAULT_SETTINGS;
    }

    let chordInfo = readMidiData(mid, settings);
    let rules = "";

    let arrayInfo = {};
    if (chordInfo.chords.size != 0) {
        arrayInfo = convertToArray(chordInfo.chords);

        rules = writeWorkshopRules(arrayInfo.owArrays, settings["voices"]);
    }
    
    return { 
        rules:              rules, 
        skippedNotes:       chordInfo.skippedNotes, 
        transposedNotes:    chordInfo.transposedNotes,
        totalElements:      arrayInfo.totalArrayElements,
        duration:           mid.duration,
        stopTime:           arrayInfo.stopTime,
        warnings:           chordInfo.warnings,
        errors:             chordInfo.errors
    };
}


function readMidiData(mid, settings) {
    // Reads the contents of a Midi object (generated by Tonejs/Midi)
    // to a map with times (float) of chords as keys 
    // and pitches (array of ints) in those chords as values

    let chords = new Map();

    let skippedNotes = 0;
    let transposedNotes = 0;

    for (let track of mid.tracks) {
        if (track.channel == 9) {
            // Percussion channel, ignore track
            continue;
        }
        
        for (let note of track.notes) {
            if (note.velocity == 0) {
                // Note off event, not used by the Overwatch piano
                continue;
            }
            if (note.time < settings["startTime"]) {
                continue;
            }

            let notePitch = note.midi;
            if (notePitch < PIANO_RANGE["MIN"] || notePitch > PIANO_RANGE["MAX"]) {
                transposedNotes += 1
                notePitch = transposePitch(notePitch);
            }

            notePitch -= PIANO_RANGE["MIN"];
            let noteTime = roundToPlaces(note.time, NOTE_PRECISION);

            if (chords.has(noteTime)) {
                if (!chords.get(noteTime).includes(notePitch)) {

                    if (chords.get(noteTime).length < settings["voices"]) {
                        chords.get(noteTime).push(notePitch);
                    } else {
                        skippedNotes += 1;
                    }
                }
            } else {
                chords.set( noteTime, [notePitch] );
            }
        }
    }

    let warnings = [];
    let errors = [];

    if (chords.size == 0) {
        errors.push(CONVERTER_ERRORS["NO_NOTES_FOUND"]);
    } else {
        // Sort by keys (times)
        chords = new Map([...chords.entries()].sort( (time1, time2) => 
                                                    { return roundToPlaces(parseFloat(time1) 
                                                      - parseFloat(time2), NOTE_PRECISION) } ));
    }

    if (mid.tracks.length == 1) {
        // Type 0 midi files have only one track
        warnings.push(CONVERTER_WARNINGS["TYPE_0_FILE"]);
    }

    return { 
        chords, 
        skippedNotes, 
        transposedNotes, 
        warnings, 
        errors 
    };
}


function convertToArray(chords) {
    // Converts the contents of the chords map 
    // to a format compatible with Overwatch

    let owArrays = {
        pitchArrays: [],
        timeArrays: [],
        chordArrays: []
    };

    let totalArrayElements = 0;

    // Time of the first note
    let prevTime = chords.keys().next().value;
    
    let stopTime = 0;
    for (let [currentChordTime, pitches] of chords.entries()) {

        // In each chord, two array elements are added (time, amount of pitches in a chord), 
        // plus one array element for each pitch in the chord
        let amountOfElementsToAdd = 2 + pitches.length;

        if (totalArrayElements + amountOfElementsToAdd > MAX_TOTAL_ARRAY_ELEMENTS) {
            // Maximum total amount of elements reached, stop adding 
            stopTime = currentChordTime;
            break;
        }
        totalArrayElements += amountOfElementsToAdd;

        // One chord in the song consists of 
        // A) time since beginning of the song
        owArrays["timeArrays"].push(roundToPlaces(currentChordTime, NOTE_PRECISION));
        // B) the amount of pitches in the chord
        owArrays["chordArrays"].push(pitches.length);
        // and C) the pitches themselves 
        for (let newPitch of pitches.sort()) {
            owArrays["pitchArrays"].push( newPitch );
        }

        prevTime = currentChordTime;
    }

    if (stopTime == 0) {
        // The entire song was added,
        // set stoptime to be the time of the last chord/note in the song
        stopTime = Array.from( chords.keys() )[chords.size - 1];
    }

    return { owArrays, totalArrayElements, stopTime };
}


function writeWorkshopRules(owArrays, maxVoices) {
    // Writes workshop rules containing the song data in arrays, 
    // ready to be pasted into Overwatch
    
    let rules = [`rule(\"Max amount of bots required\"){event{Ongoing-Global;}` +
    `actions{Global.maxBots = ${maxVoices};Global.maxArraySize = ${MAX_OW_ARRAY_SIZE};}}\n`];

    // Write all 3 arrays in owArrays to workshop rules
    for (let [arrayName, songArray] of Object.entries(owArrays)) {

        // Index of the current overwatch array being written to
        let owArrayIndex = 0;

        // Index of the current JS array element being written
        let songArrayIndex = 0;
        while (songArrayIndex < songArray.length) {

            let actions = `Global.${arrayName}[${owArrayIndex}] = Array(${songArray[songArrayIndex]}`;
            songArrayIndex += 1;
            
            // Write 998 elements at a time to avoid going over the array size limit 
            for (let i = 0; i < MAX_OW_ARRAY_SIZE - 1; i++) {
                actions += `, ${songArray[songArrayIndex]}`;
                songArrayIndex += 1;

                if (songArrayIndex >= songArray.length) {
                    break;
                }
            }

            actions += `);`
            let newRule = `rule(\"${arrayName}\"){event{Ongoing-Global;}` +
                          `actions{${actions}}}\n`;       
            rules.push(newRule);
            owArrayIndex += 1;
        }
    }

    return rules.join("");
}


function transposePitch(pitch) {
    while (pitch < PIANO_RANGE["MIN"]) {
        pitch += OCTAVE;
    }
    while (pitch > PIANO_RANGE["MAX"]) {
        pitch -= OCTAVE;
    }
    return pitch;
}

function roundToPlaces(value, decimalPlaces) {
    return Math.round(value * Math.pow(10, decimalPlaces)) / Math.pow(10, decimalPlaces);
}
