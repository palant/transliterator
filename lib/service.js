/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the "License"). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 */

CU.import("resource://gre/modules/XPCOMUtils.jsm");
CU.import("resource://gre/modules/Services.jsm");

var {Converter} = require("converter");
var {TransliteratorWindowDelegate} = require("delegate");
var {EndPoint} = require("endPoint");
var {PrefObserver} = require("prefObserver");

var TransliteratorService = exports.TransliteratorService = {
  //method of nsISupports interface
  QueryInterface: XPCOMUtils.generateQI([CI.nsIObserver, CI.nsISupportsWeakReference]),

  init: function() {
    //init variables
    this.delegates = []; // list of adapters
    this.prefsConverted = false;


    // attach to preferences
    this.prefBranch =  Services.prefs.getBranch("extensions.transliterator.");

    //install pref observer
    this.prefObserver = new PrefObserver(this.prefBranch, this);

    // etc
    //this.initEndPoints();

    // Attach to any windows already open
    let enumerator = Services.ww.getWindowEnumerator();
    while (enumerator.hasMoreElements())
      this.attachToWindow(enumerator.getNext());

    // register observers
    Services.obs.addObserver(this, "domwindowopened", true);
    Services.obs.addObserver(this, "domwindowclosed", true);
  },

  setUnicodePref: function (prefName,prefValue,prefBranch) {
    if (!prefBranch)
      prefBranch = this.prefBranch;

    var sString = CC["@mozilla.org/supports-string;1"].createInstance(CI.nsISupportsString);
    sString.data = prefValue;
    prefBranch.setComplexValue(prefName, CI.nsISupportsString, sString);
  },

  getUnicodePref: function (prefName, prefBranch) {
    if (!prefBranch)
      prefBranch = this.prefBranch;
    try {
      return prefBranch.getComplexValue(prefName, CI.nsISupportsString).data;
    } catch (e) {
      return prefBranch.getCharPref(prefName);
    }
  },

  getCharPref: function(prefName, prefBranch) {
    if (!prefBranch)
      prefBranch = this.prefBranch;
    return prefBranch.getCharPref(prefName);
  },

  getBoolPref: function(prefName, prefBranch) {
    if (!prefBranch)
        prefBranch = this.prefBranch;

    try {
        return prefBranch.getBoolPref(prefName);
    } catch (e) {
        //silence the exception
       return false;
    }
  },

  cleanup: function() {
    // unregister observers
    Services.obs.removeObserver(this, "domwindowopened");
    Services.obs.removeObserver(this, "domwindowclosed");

    //detach from prefs
    if (this.prefObserver)
      this.prefObserver.unregister();

    // detach from windows
    for (var i = 0; i < this.delegates.length; i++)
      this.delegates[i].detach();
    // etc
  },

  debug: function(value) {
    dump(value + "\n");
  },

  log: function(value) {
    this.debug(value);
    Services.console.logStringMessage("Transliterator: " + value);
  },

  // nsIObserver implementation
  observe: function(aSubject, aTopic, aData) {
    if (aTopic == "domwindowopened") {
      this.attachToWindow(aSubject);
    }
    else if (aTopic == "domwindowclosed") {
      this.detachFromWindow(aSubject);
    }
  },

  attachToWindow: function(wnd) {
    this.delegates.push(new TransliteratorWindowDelegate(this, wnd));
  },

  detachFromWindow: function(wnd) {
    var delegate = wnd.transliterator;
    var i = -1;
    if (this.delegates.indexOf)
      i = this.delegates.indexOf(delegate);
    else {
     // for old gecko
     for (var j = 0; j < this.delegates.length; j++)
      if (this.delegates[i] == delegate) {
        i = j;
        break;
      }
    }
    if (i >= 0)
      this.delegates.splice(i, 1);

    //TODO: need delegate.detach() here?
  },

  // call this when menus or shortcuts change
  updateEndPoints: function() {
    // nothing to update yet
    if (!this._endPoints || this._endPoints.length == 0)
      return;

    //this.initEndPoints();
    this._endPoints = null; // cleared endpoints

    // save a copy of the list before calling reconfigure to avoid concurrent mod
    var delegatesToReconfigure = [];
    for (var i = 0; i < this.delegates.length; i++)
      delegatesToReconfigure.push(this.delegates[i]);

    for (var i = 0; i < delegatesToReconfigure.length; i++)
      delegatesToReconfigure[i].reconfigure();

  },

  getPreferredLayout: function() {
    var layout = this.getUnicodePref("layout");
    if (layout == "")
      layout = null;
    return layout;
  },

  // return {key, modifiers}
  parseKeyString: function(keyString) {
    keyString = keyString.toLowerCase();

    var found = keyString.match(/(vk_[A-Z0-9]+)/i);
    if (!found)
      return null;
    var keyCode = found[0];
    var mods = "";


    keyString = keyString.replace(/ctrl/i, "control");
    var stdmods = new Array("accel", "alt", "control", "meta", "shift");
    for (var i = 0; i < stdmods.length; i++) {
      if (keyString.indexOf(stdmods[i]) >= 0)
        mods += (mods == "" ? "" : ", ") + stdmods[i];
    }

    return {key: keyCode.toUpperCase(), modifiers: mods};
  },

  createConverter: function(layoutName, reversed) {
    var layout = this.getUnicodePref("layouts." + layoutName);

    var caseSensitive = this.getBoolPref("layouts." + layoutName + ".case_sensitive");

    var convTable = JSON.parse(layout);

    return new Converter(convTable, caseSensitive, reversed);

  },

  initEndPoints: function() {
    if (!this.prefsConverted) {
      this.prefsConverted = true;
      this.convertPreferences();
    }

    //instead of one converter for all, place converter selection into commands

    var converter = this.createConverter(this.getPreferredLayout() || "default", false)
    var reverseConv = this.createConverter(this.getPreferredLayout() || "default", true);

    var endPoints = [
      {cmd: "fromtranslit", type: EndPoint.BATCH, conv: converter},
      {cmd: "totranslit", type: EndPoint.BATCH, conv: reverseConv},
      {cmd: "togglemode", type: EndPoint.MAP, conv: converter}
    ];

    this._endPoints = [];
    for (var i = 0; i < endPoints.length; i++) {
      var label = this.getUnicodePref("commands." + endPoints[i].cmd + ".label");
      var shortcut = this.parseKeyString(this.getCharPref("commands." + endPoints[i].cmd + ".shortcut"));
      if (!shortcut)
        shortcut = {key: "", modifiers: ""};

      this._endPoints.push(
        new EndPoint("cmd_" + endPoints[i].cmd, label, shortcut.key, shortcut.modifiers, endPoints[i].type, endPoints[i].conv)
      );
    }


    /*
    this._endPoints = [
      //EndPoint(commandKey, menuLabel, keycode, modifiers, actionType, converter )
      new EndPoint("cmd_transliterator_toggle", "Cyrillic Mode", "VK_F2", "", EndPoint.MAP, converter),
      new EndPoint("cmd_transliterator_fwd", "To Cyrillic", "VK_Q", "control shift", EndPoint.BATCH, converter),
      new EndPoint("cmd_transliterator_back", "To Translit", "VK_Q", "control alt shift", EndPoint.BATCH, reverseConv),
    ];
    */

  },

  // return array of entry points
  getEndPoints: function() {

    if (!this._endPoints)
      this.initEndPoints();

    return this._endPoints;
  },

  convertPreferences: function() {
    //convert prefs from extensions.tocyrillic to extensions.transliterator
    var converted = this.getBoolPref("prefs_converted");
    if (converted)
      return;

    var oldPrefBranch = Services.prefs.getBranch("extensions.tocyrillic.");
    var childCount = new Object();
    var list = oldPrefBranch.getChildList("", childCount);

    for (var i = 0; i < childCount.value; i++)
      if (oldPrefBranch.prefHasUserValue(list[i])) {

        if (list[i] == "layout")
          this.prefBranch.setCharPref("layout", oldPrefBranch.getCharPref(list[i]));

        else if (list[i].indexOf("labels") == 0) {
          var cmdcode = list[i].substring(7);
          this.setUnicodePref("commands." + cmdcode + ".label", this.getUnicodePref(list[i], oldPrefBranch));
        }

        else if (list[i].indexOf("shortcuts") == 0) {
          var cmdcode = list[i].substring(7);
          this.prefBranch.setCharPref("commands." + cmdcode + ".label", oldPrefBranch.getCharPref(list[i]));
        }

        else {
          // copy layouts
          this.setUnicodePref(list[i], this.getUnicodePref(list[i], oldPrefBranch));
        }

      }

    this.prefBranch.setBoolPref("prefs_converted", true);
  }
};