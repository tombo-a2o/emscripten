var LibraryCoreAudio = {
    $CoreAudio__deps: [],
    $CoreAudio__postset: "CoreAudio.init();",
    $CoreAudio: {
        context: null,
        audioBuffers: {},
        audioPlayers: {},
        playerIdCounter: 1,
        gainRatio: 1,
        init: function() {
            if(typeof window === 'undefined') {
                Module.printErr("CoreAudio is not available.");
                return;
            }
            window.AudioContext = window.AudioContext || window.webkitAudioContext;
            CoreAudio.context = new AudioContext();

            // disable audio plugin and use mine
            Module["noAudioDecoding"] = true;
            Module["noImageDecoding"] = true;

            if (!Module["preloadPlugins"]) Module["preloadPlugins"] = [];
            Module['preloadPlugins'].push({
                canHandle: function(name) {
                    return name.substr(-4) in { '.caf': 1, '.ogg': 1, '.wav': 1, '.mp3': 1 };
                },
                handle: function(byteArray, name, onload, onerror) {
                    var ui8Array = new Uint8Array(byteArray);
                    CoreAudio.context.decodeAudioData(ui8Array.buffer, function(decoded){
                        CoreAudio.audioBuffers[name] = decoded;
                        if(onload) onload(byteArray);
                    },
                    function(err){
                        if(onerror) onerror();
                    });
                }
            });

            // to avoid iOS's restriction, we need to play some sound on touch"END"
            window.addEventListener('touchend', function unlock() {
                window.removeEventListener('touchend', unlock);
                var buffer = CoreAudio.context.createBuffer(1, 1, 22050);
                var source = CoreAudio.context.createBufferSource();
                source.buffer = buffer;
                source.connect(CoreAudio.context.destination);
                if (typeof source.noteOn === "function") {
                    source.noteOn(0);
                }
            }, false);

        },

        calcPosition: function(now, begin, duration) {
            var pos = now - begin;
            while(pos >= duration) pos -= duration;
            return pos;
        },

        setGainRatio: function(gainRatio) {
            CoreAudio.gainRatio = gainRatio;
            Object.keys(CoreAudio.audioPlayers).forEach(function(key) {
                var audioPlayer = CoreAudio.audioPlayers[key];
                if (audioPlayer.gain) {
                    audioPlayer.gain.gain.value = audioPlayer.volume * gainRatio;
                }
            });
        }
    },

    // audipBuffer* are used from ExtAudioFile+ in AudioToolBox
    audioBuffer_sampleRate: function(name) {
        var _name = Pointer_stringify(name);
        var audioBuffer = CoreAudio.audioBuffers[_name];

        if(!audioBuffer) {
            Module.printErr("audioBuffer not found");
            return 0.0;
        }
        return audioBuffer.sampleRate;
    },
    audioBuffer_length: function(name) {
        var _name = Pointer_stringify(name);
        var audioBuffer = CoreAudio.audioBuffers[_name];

        if(!audioBuffer) {
            Module.printErr("audioBuffer not found");
            return 0;
        }
        return audioBuffer.length;
    },
    audioBuffer_numberOfChannels: function(name) {
        var _name = Pointer_stringify(name);
        var audioBuffer = CoreAudio.audioBuffers[_name];

        if(!audioBuffer) {
            Module.printErr("audioBuffer not found");
            return 0;
        }
        return audioBuffer.numberOfChannels;
    },
    audioBuffer_read: function(name, channels, bytes, data) {
        var _name = Pointer_stringify(name);
        var audioBuffer = CoreAudio.audioBuffers[_name];

        if(!audioBuffer) {
            Module.printErr("audioBuffer not found");
            return;
        }

        var dat = [];
        for(var ch = 0; ch < channels; ch++)
            dat[ch] = audioBuffer.getChannelData(ch);

        for (var i = 0; i < audioBuffer.length; i++) {
            for (var ch = 0; ch < channels; ch++) {
                var val = dat[ch][i]; // [-1.0, 1.0]
                switch (bytes) {
                case 1:
                    {{{ makeSetValue('data', 'i*channels+ch', '(val+1.0)*255/2', 'i8') }}};
                    break;
                case 2:
                    {{{ makeSetValue('data', '2*(i*channels+ch)', 'val*32768', 'i16') }}};
                    break;
                case 4:
                    {{{ makeSetValue('data', '4*(i*channels+ch)', 'val', 'float') }}};
                    break;
                }
            }
        }
    },

    // audipPlayer* are used from AVAudioPlayer in AVFoundation
    audioPlayer_create: function(name) {
        var _name = Pointer_stringify(name);
        var audioBuffer = CoreAudio.audioBuffers[_name];

        if(!audioBuffer) {
            Module.printErr("audioBuffer not found");
            return 0;
        }

        var playerId = CoreAudio.playerIdCounter++;
        CoreAudio.audioPlayers[playerId] = {
            buffer: audioBuffer,
            volume: 1.0,
            numberOfLoops: 1,
            beginAt: 0.0,
            offset: 0.0
        };
        return playerId;
    },
    audioPlayer_play: function(playerId, delay) {
        var player = CoreAudio.audioPlayers[playerId];
        var source = player.source = CoreAudio.context.createBufferSource();
        var gain = player.gain = CoreAudio.context.createGain();

        source.buffer = player.buffer;
        source.connect(gain);

        gain.gain.value = player.volume * CoreAudio.gainRatio;
        gain.connect(CoreAudio.context.destination);

        var beginAt = player.beginAt = CoreAudio.context.currentTime + delay;
        var offset = player.offset;
        if(player.numberOfLoops > 0) {
            source.loop = false;
            var duration = player.buffer.duration;
            source.start(beginAt, offset, player.numberOfLoops*duration);
        } else {
            source.loop = true;
            source.start(beginAt, offset);
        }
    },
    audioPlayer_stop: function(playerId) {
        var player = CoreAudio.audioPlayers[playerId];
        var source = player.source;
        if(source) {
            source.stop();
            delete player.gain;
            delete player.source;
        }
        player.offset = CoreAudio.calcPosition(CoreAudio.context.currentTime, player.beginAt, player.buffer.duration);
    },
    audioPlayer_isPlaying: function(playerId) {
        var player = CoreAudio.audioPlayers[playerId];
        return player.source ? 1 : 0;
    },
    audioPlayer_setVolume: function(playerId, volume) {
        var player = CoreAudio.audioPlayers[playerId];
        player.volume = volume;
        var gain = player.gain;
        if(gain) {
            gain.gain.value = volume * CoreAudio.gainRatio;
        }
    },
    audioPlayer_setNumberOfLoops: function(playerId, numberOfLoops) {
        var player = CoreAudio.audioPlayers[playerId];
        if(numberOfLoops == 0) numberOfLoops = 1;
        player.numberOfLoops = numberOfLoops;
    },
    audioPlayer_setOffset: function(playerId, offset) {
        var player = CoreAudio.audioPlayers[playerId];
        player.offset = offset;
    },
    audioPlayer_getPosition: function(playerId) {
        var player = CoreAudio.audioPlayers[playerId];
        if(player.source) {
            return CoreAudio.calcPosition(CoreAudio.context.currentTime, player.beginAt, player.buffer.duration);
        } else {
            return player.offset;
        }
    },
    audioPlayer_destroy: function(playerId) {
        delete CoreAudio.audioPlayers[playerId];
    },
    audioPlayer_stopAll__deps: ['audioPlayer_stop'],
    audioPlayer_stopAll: function() {
        for(playerId in CoreAudio.audioPlayers) {
            _audioPlayer_stop(playerId)
        }
    }
};

autoAddDeps(LibraryCoreAudio, '$CoreAudio');
mergeInto(LibraryManager.library, LibraryCoreAudio);
