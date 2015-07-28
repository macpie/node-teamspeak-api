var net = require('net'),
    line = require('line-input-stream'),
    events = require('events'),
    util = require('util');

function TeamSpeak(host, port) {
    var self = this;

    events.EventEmitter.call(self);

    self.port = port || 10011;
    self.host = host || 'localhost';
    self.status = -2;
    self.q = [];
    self.exe = null;
    self.api = {};

    self._init_cmds();

    self.connect();

    return self;
}

util.inherits(TeamSpeak, events.EventEmitter);

TeamSpeak.prototype.connect = function() {
    var self = this;

    self.socket = net.connect(self.port, self.host);

    self.socket.on('error', function(err) {
        self.emit('error', err);
    });

    self.socket.on('close', function() {
        self.emit('close', self.q);
    });

    self.socket.on('end', function() {
        self.emit('end', self.q);
    });

    self._on_connect();

    return self;
};

TeamSpeak.prototype.disconnect = function() {
    var self = this;

    self.socket.end();

    return self;
};

TeamSpeak.prototype.subscribe = function() {
    var self = this,
        args = Array.prototype.slice.call(arguments);

    return self.api.servernotifyregister.apply(self, args);
};

TeamSpeak.prototype.unsubscribe = function() {
    var self = this,
        args = Array.prototype.slice.call(arguments);

    return self.api.servernotifyunregister.apply(self, args);
};

TeamSpeak.prototype.send = function() {
    var self = this,
        args = Array.prototype.slice.call(arguments),
        options = [],
        params = {},
        callback,
        cmd = args.shift();

    args.forEach(function(v) {
        if (util.isArray(v)) {
            options = v;
        } else if (typeof v === "function") {
            callback = v;
        } else if (typeof v === "string") {
            options.push(v);
        } else {
            params = v;
        }
    });

    var toSend = escape(cmd);

    options.forEach(function(v) {
        toSend += " -" + escape(v);
    });

    for (var key in params) {
        var value = params[key];

        if (util.isArray(value)) {
            for (var i in value) {
                value[i] = escape(key) + "=" + escape(value[i]);
            }
            toSend += " " + value.join("|");
        } else {
            toSend += " " + escape(key.toString()) + "=" + escape(value.toString());
        }
    }

    self.q.push({
        cmd: cmd,
        options: options,
        parameters: params,
        text: toSend,
        cb: callback
    });

    if (self.status === 0) {
        self.advance_queue();
    }

    return self;
};

TeamSpeak.prototype.advance_queue = function() {
    var self = this;

    if (!self.exe && self.q.length >= 1) {
        self.exe = self.q.shift();
        self.socket.write(self.exe.text + "\n");
    }

    return self;
};

TeamSpeak.prototype.pending = function() {
    return this.q.slice(0);
};

TeamSpeak.prototype.clear_pending = function() {
    var self = this,
        q = self.q;

    self.q = [];

    return q;
};

TeamSpeak.prototype._init_cmds = function() {
    var self = this,
        commands = require('./commands');

    commands.forEach(function(cmd) {
        self.api[cmd] = function() {
            var args = Array.prototype.slice.call(arguments);

            args.unshift(cmd);

            return self.send.apply(self, args);
        };
    });

    return self;
};

TeamSpeak.prototype._on_connect = function() {
    var self = this;

    self.socket.on('connect', function() {
        var reader = line(self.socket);

        reader.on('line', function(data) {
            var str = data.trim();

            if (self.status < 0) {
                self.status++;
                if (self.status === 0) self.advance_queue();
                return;
            }

            self._on_data(str);
        });

        self.emit('connect');
    });

    return self;
};

TeamSpeak.prototype._on_data = function(str) {
    var self = this;

    if (str.indexOf('error') === 0) {

        var resp = parse_resp(str.substr(6).trim());

        if (resp.id === 0) {
            self.exe.error = null;
            if (!self.exe.resp) self.exe.resp = {
                status: 'ok',
                raw: str
            };
        } else {
            self.exe.error = {
                status: 'error',
                message: resp.msg,
                error_id: resp.id
            };
        }

        var req = {
            cmd: self.exe.cmd,
            options: self.exe.options,
            params: self.exe.parameters,
            raw: self.exe.text
        };

        if (typeof self.exe.cb == 'function') {
            self.exe.cb.call(
                self.exe,
                self.exe.error,
                self.exe.resp,
                req
            );
        } else {
            self.emit(
                self.exe.cmd,
                self.exe.error,
                self.exe.resp,
                req
            );
        }

        self.exe = null;
        self.advance_queue();
    } else if (str.indexOf('notify') === 0) {
        str = str.substr(6);

        var eventName = str.substr(0, str.indexOf(" ")),
            notifyResp = parse_resp(str.substr(eventName.length + 1));

        self.emit('notify', eventName, notifyResp);

        self.emit('notify.' + eventName, eventName, notifyResp);

    } else if (self.exe) {
        self.exe.resp = {
            status: 'ok',
            data: parse_resp(str),
            raw: str
        };
    }

    return self;
};

function escape(str) {
    str = str.replace(/\\/g, '\\\\');
    str = str.replace(/\//g, '\\/');
    str = str.replace(/\|/g, '\\p');
    str = str.replace(/\n/g, '\\n');
    str = str.replace(/\r/g, '\\r');
    str = str.replace(/\t/g, '\\t');
    str = str.replace(/\v/g, '\\v');
    str = str.replace(/\f/g, '\\f');
    str = str.replace(/ /g, '\\s');

    return str;
}

function unescape(str) {
    str = str.replace(/\\s/g, ' ');
    str = str.replace(/\\p/g, '|');
    str = str.replace(/\\n/g, '\n');
    str = str.replace(/\\f/g, '\f');
    str = str.replace(/\\r/g, '\r');
    str = str.replace(/\\t/g, '\t');
    str = str.replace(/\\v/g, '\v');
    str = str.replace(/\\\//g, '\/');
    str = str.replace(/\\\\/g, '\\');

    return str;
}

function parse_resp(str) {
    var self = this,
        resp = [],
        records = str.split('|');

    resp = records.map(function(k) {
        var args = k.split(' '),
            obj = {};

        args.forEach(function(v) {
            if (v.indexOf('=') > -1) {
                var key = unescape(v.substr(0, v.indexOf('='))),
                    value = unescape(v.substr(v.indexOf('=') + 1));

                if (parseInt(value, 10) == value) {
                    value = parseInt(value, 10);
                }
                obj[key] = value;

            } else {
                obj[v] = '';
            }
        });

        return obj;
    });

    if (resp.length === 0) {
        resp = null;
    } else if (resp.length === 1) {
        resp = resp.shift();
    }

    return resp;
};

module.exports = TeamSpeak;