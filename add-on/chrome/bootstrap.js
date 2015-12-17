/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

/* exported startup, shutdown, install, uninstall */

const { interfaces: Ci, utils: Cu, classes: Cc } = Components;

const kNSXUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const kBrowserSharingNotificationId = "loop-sharing-notification";
const kPrefBrowserSharingInfoBar = "browserSharing.showInfoBar";

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/AppConstants.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "PrivateBrowsingUtils",
  "resource://gre/modules/PrivateBrowsingUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "CustomizableUI",
  "resource:///modules/CustomizableUI.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Task",
  "resource://gre/modules/Task.jsm");

/**
 * This window listener gets loaded into each browser.xul window and is used
 * to provide the required loop functions for the window.
 */
var WindowListener = {
  /**
   * Sets up the chrome integration within browser windows for Loop.
   *
   * @param {Object} window The window to inject the integration into.
   */
  setupBrowserUI: function(window) {
    let document = window.document;
    let gBrowser = window.gBrowser;
    let xhrClass = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"];
    let FileReader = window.FileReader;
    let menuItem = null;

    // the "exported" symbols
    var LoopUI = {
      /**
       * @var {XULWidgetSingleWrapper} toolbarButton Getter for the Loop toolbarbutton
       *                                             instance for this window. This should
       *                                             not be used in the hidden window.
       */
      get toolbarButton() {
        delete this.toolbarButton;
        return (this.toolbarButton = CustomizableUI.getWidget("loop-button").forWindow(window));
      },

      /**
       * @var {XULElement} panel Getter for the Loop panel element.
       */
      get panel() {
        delete this.panel;
        return (this.panel = document.getElementById("loop-notification-panel"));
      },

      /**
       * @var {XULElement|null} browser Getter for the Loop panel browser element.
       *                                Will be NULL if the panel hasn't loaded yet.
       */
      get browser() {
        let browser = document.querySelector("#loop-notification-panel > #loop-panel-iframe");
        if (browser) {
          delete this.browser;
          this.browser = browser;
        }
        return browser;
      },

      /**
       * @return {Promise}
       */
      promiseDocumentVisible(aDocument) {
        if (!aDocument.hidden) {
          return Promise.resolve(aDocument);
        }

        return new Promise((resolve) => {
          aDocument.addEventListener("visibilitychange", function onVisibilityChanged() {
            aDocument.removeEventListener("visibilitychange", onVisibilityChanged);
            resolve(aDocument);
          });
        });
      },

      /**
       * Toggle between opening or hiding the Loop panel.
       *
       * @param {DOMEvent} [event] Optional event that triggered the call to this
       *                           function.
       * @param {String}   [tabId] Optional name of the tab to select after the panel
       *                           has opened. Does nothing when the panel is hidden.
       * @return {Promise}
       */
      togglePanel: function(event, tabId = null) {
        if (!this.panel) {
          // We're on the hidden window! What fun!
          let obs = win => {
            Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
            win.LoopUI.togglePanel(event, tabId);
          };
          Services.obs.addObserver(obs, "browser-delayed-startup-finished", false);
          return window.OpenBrowserWindow();
        }
        if (this.panel.state == "open") {
          return new Promise(resolve => {
            this.panel.hidePopup();
            resolve();
          });
        }

        return this.openCallPanel(event, tabId).then(doc => {
          let fm = Services.focus;
          fm.moveFocus(doc.defaultView, null, fm.MOVEFOCUS_FIRST, fm.FLAG_NOSCROLL);
        }).catch(err => {
          Cu.reportError(err);
        });
      },

      /**
       * Opens the panel for Loop and sizes it appropriately.
       *
       * @param {event}  event   The event opening the panel, used to anchor
       *                         the panel to the button which triggers it.
       * @param {String} [tabId] Identifier of the tab to select when the panel is
       *                         opened. Example: 'rooms', 'contacts', etc.
       * @return {Promise}
       */
      openCallPanel: function(event, tabId = null) {
        return new Promise((resolve) => {
          let callback = iframe => {
            // Helper function to show a specific tab view in the panel.
            function showTab() {
              if (!tabId) {
                resolve(LoopUI.promiseDocumentVisible(iframe.contentDocument));
                return;
              }

              let win = iframe.contentWindow;
              let ev = new win.CustomEvent("UIAction", Cu.cloneInto({
                detail: {
                  action: "selectTab",
                  tab: tabId
                }
              }, win));
              win.dispatchEvent(ev);
              resolve(LoopUI.promiseDocumentVisible(iframe.contentDocument));
            }

            // If the panel has been opened and initialized before, we can skip waiting
            // for the content to load - because it's already there.
            if (("contentWindow" in iframe) && iframe.contentWindow.document.readyState == "complete") {
              showTab();
              return;
            }

            let documentDOMLoaded = () => {
              iframe.removeEventListener("DOMContentLoaded", documentDOMLoaded, true);
              // Handle window.close correctly on the panel.
              this.hookWindowCloseForPanelClose(iframe.contentWindow);
              iframe.contentWindow.addEventListener("loopPanelInitialized", function loopPanelInitialized() {
                iframe.contentWindow.removeEventListener("loopPanelInitialized",
                  loopPanelInitialized);
                showTab();
              });
            };
            iframe.addEventListener("DOMContentLoaded", documentDOMLoaded, true);
          };

          // Used to clear the temporary "login" state from the button.
          Services.obs.notifyObservers(null, "loop-status-changed", null);

          this.shouldResumeTour().then((resume) => {
            if (resume) {
              // Assume the conversation with the visitor wasn't open since we would
              // have resumed the tour as soon as the visitor joined if it was (and
              // the pref would have been set to false already.
              this.MozLoopService.resumeTour("waiting");
              resolve();
              return;
            }

            this.LoopAPI.initialize();

            let anchor = event ? event.target : this.toolbarButton.anchor;
            let setHeight = 410;
            if (gBrowser.selectedBrowser.getAttribute("remote") === "true") {
              setHeight = 262;
            }
            this.PanelFrame.showPopup(window, anchor,
              "loop", null, "about:looppanel",
              // Loop wants a fixed size for the panel. This also stops it dynamically resizing.
              { width: 330, height: setHeight },
              callback);
          });
        });
      },

      /**
       * Method to know whether actions to open the panel should instead resume the tour.
       *
       * We need the panel to be opened via UITour so that it gets @noautohide.
       *
       * @return {Promise} resolving with a {Boolean} of whether the tour should be resumed instead of
       *                   opening the panel.
       */
      shouldResumeTour: Task.async(function* () {
        // Resume the FTU tour if this is the first time a room was joined by
        // someone else since the tour.
        if (!Services.prefs.getBoolPref("loop.gettingStarted.resumeOnFirstJoin")) {
          return false;
        }

        if (!this.LoopRooms.participantsCount) {
          // Nobody is in the rooms
          return false;
        }

        let roomsWithNonOwners = yield this.roomsWithNonOwners();
        if (!roomsWithNonOwners.length) {
          // We were the only one in a room but we want to know about someone else joining.
          return false;
        }

        return true;
      }),

      /**
       * @return {Promise} resolved with an array of Rooms with participants (excluding owners)
       */
      roomsWithNonOwners: function() {
        return new Promise(resolve => {
          this.LoopRooms.getAll((error, rooms) => {
            let roomsWithNonOwners = [];
            for (let room of rooms) {
              if (!("participants" in room)) {
                continue;
              }
              let numNonOwners = room.participants.filter(participant => !participant.owner).length;
              if (!numNonOwners) {
                continue;
              }
              roomsWithNonOwners.push(room);
            }
            resolve(roomsWithNonOwners);
          });
        });
      },

      /**
       * Triggers the initialization of the loop service if necessary.
       * Also adds appropraite observers for the UI.
       */
      init: function() {
        // This is a promise for test purposes, but we don't want to be logging
        // expected errors to the console, so we catch them here.
        this.MozLoopService.initialize().catch(ex => {
          if (!ex.message ||
              (!ex.message.contains("not enabled") &&
               !ex.message.contains("not needed"))) {
            console.error(ex);
          }
        });

        this.addMenuItem();

        // Don't do the rest if this is for the hidden window - we don't
        // have a toolbar there.
        if (window == Services.appShell.hiddenDOMWindow) {
          return;
        }

        // Cleanup when the window unloads.
        window.addEventListener("unload", () => {
          Services.obs.removeObserver(this, "loop-status-changed");
        });

        Services.obs.addObserver(this, "loop-status-changed", false);

        this.updateToolbarState();
      },

      /**
       * Adds a menu item to the browsers' Tools menu that open the Loop panel
       * when selected.
       */
      addMenuItem: function() {
        let menu = document.getElementById("menu_ToolsPopup");
        if (!menu || menuItem) {
          return;
        }

        menuItem = document.createElementNS(kNSXUL, "menuitem");
        menuItem.setAttribute("id", "menu_openLoop");
        menuItem.setAttribute("label", this._getString("loopMenuItem_label"));
        menuItem.setAttribute("accesskey", this._getString("loopMenuItem_accesskey"));

        menuItem.addEventListener("command", () => this.togglePanel());

        menu.insertBefore(menuItem, document.getElementById("sync-setup"));
      },

      /**
       * Removes the menu item from the browsers' Tools menu.
       */
      removeMenuItem: function() {
        if (menuItem) {
          menuItem.parentNode.removeChild(menuItem);
        }
      },

      // Implements nsIObserver
      observe: function(subject, topic, data) {
        if (topic != "loop-status-changed") {
          return;
        }
        this.updateToolbarState(data);
      },

      /**
       * Updates the toolbar/menu-button state to reflect Loop status. This should
       * not be called from the hidden window.
       *
       * @param {string} [aReason] Some states are only shown if
       *                           a related reason is provided.
       *
       *                 aReason="login": Used after a login is completed
       *                   successfully. This is used so the state can be
       *                   temporarily shown until the next state change.
       */
      updateToolbarState: function(aReason = null) {
        if (!this.toolbarButton.node) {
          return;
        }
        let state = "";
        let mozL10nId = "loop-call-button3";
        let suffix = ".tooltiptext";
        if (this.MozLoopService.errors.size) {
          state = "error";
          mozL10nId += "-error";
        } else if (this.MozLoopService.screenShareActive) {
          state = "action";
          mozL10nId += "-screensharing";
        } else if (aReason == "login" && this.MozLoopService.userProfile) {
          state = "active";
          mozL10nId += "-active";
          suffix += "2";
        } else if (this.MozLoopService.doNotDisturb) {
          state = "disabled";
          mozL10nId += "-donotdisturb";
        } else if (this.MozLoopService.roomsParticipantsCount > 0) {
          state = "active";
          this.roomsWithNonOwners().then(roomsWithNonOwners => {
            if (roomsWithNonOwners.length > 0) {
              mozL10nId += "-participantswaiting";
            } else {
              mozL10nId += "-active";
            }

            suffix += "2";
            this.updateTooltiptext(mozL10nId + suffix);
            this.toolbarButton.node.setAttribute("state", state);
          });
          return;
        } else {
          suffix += "2";
        }

        this.toolbarButton.node.setAttribute("state", state);
        this.updateTooltiptext(mozL10nId + suffix);
      },

      /**
       * Updates the tootltiptext to reflect Loop status. This should not be called
       * from the hidden window.
       *
       * @param {string} [mozL10nId] l10n ID that refelct the current
       *                           Loop status.
       */
      updateTooltiptext: function(mozL10nId) {
        this.toolbarButton.node.setAttribute("tooltiptext", mozL10nId);
        var tooltiptext = CustomizableUI.getLocalizedProperty(this.toolbarButton, "tooltiptext");
        this.toolbarButton.node.setAttribute("tooltiptext", tooltiptext);
      },

      /**
       * Show a desktop notification when 'do not disturb' isn't enabled.
       *
       * @param {Object} options Set of options that may tweak the appearance and
       *                         behavior of the notification.
       *                         Option params:
       *                         - {String}   title       Notification title message
       *                         - {String}   [message]   Notification body text
       *                         - {String}   [icon]      Notification icon
       *                         - {String}   [sound]     Sound to play
       *                         - {String}   [selectTab] Tab to select when the panel
       *                                                  opens
       *                         - {Function} [onclick]   Callback to invoke when
       *                                                  the notification is clicked.
       *                                                  Opens the panel by default.
       */
      showNotification: function(options) {
        if (this.MozLoopService.doNotDisturb) {
          return;
        }

        if (!options.title) {
          throw new Error("Missing title, can not display notification");
        }

        let notificationOptions = {
          body: options.message || ""
        };
        if (options.icon) {
          notificationOptions.icon = options.icon;
        }
        if (options.sound) {
          // This will not do anything, until bug bug 1105222 is resolved.
          notificationOptions.mozbehavior = {
            soundFile: ""
          };
          this.playSound(options.sound);
        }

        let notification = new window.Notification(options.title, notificationOptions);
        notification.addEventListener("click", () => {
          if (window.closed) {
            return;
          }

          try {
            window.focus();
          } catch (ex) {
            // Do nothing.
          }

          // We need a setTimeout here, otherwise the panel won't show after the
          // window received focus.
          window.setTimeout(() => {
            if (typeof options.onclick == "function") {
              options.onclick();
            } else {
              // Open the Loop panel as a default action.
              this.openCallPanel(null, options.selectTab || null);
            }
          }, 0);
        });
      },

      /**
       * Play a sound in this window IF there's no sound playing yet.
       *
       * @param {String} name Name of the sound, like 'ringtone' or 'room-joined'
       */
      playSound: function(name) {
        if (this.ActiveSound || this.MozLoopService.doNotDisturb) {
          return;
        }

        this.activeSound = new window.Audio();
        this.activeSound.src = `chrome://loop/content/shared/sounds/${name}.ogg`;
        this.activeSound.load();
        this.activeSound.play();

        this.activeSound.addEventListener("ended", () => this.activeSound = undefined, false);
      },

      /**
       * Start listening to selected tab changes and notify any content page that's
       * listening to 'BrowserSwitch' push messages.
       *
       * Push message parameters:
       * - {Integer} windowId  The new windowId for the browser.
       */
      startBrowserSharing: function() {
        if (!this._listeningToTabSelect) {
          gBrowser.tabContainer.addEventListener("TabSelect", this);
          this._listeningToTabSelect = true;

          // Watch for title changes as opposed to location changes as more
          // metadata about the page is available when this event fires.
          gBrowser.addEventListener("DOMTitleChanged", this);
        }

        this._maybeShowBrowserSharingInfoBar();

        // Get the first window Id for the listener.
        this.LoopAPI.broadcastPushMessage("BrowserSwitch",
          gBrowser.selectedBrowser.outerWindowID);
      },

      /**
       * Stop listening to selected tab changes.
       */
      stopBrowserSharing: function() {
        if (!this._listeningToTabSelect) {
          return;
        }

        this._hideBrowserSharingInfoBar();
        gBrowser.tabContainer.removeEventListener("TabSelect", this);
        gBrowser.removeEventListener("DOMTitleChanged", this);
        this._listeningToTabSelect = false;
      },

      /**
       * Helper function to fetch a localized string via the MozLoopService API.
       * It's currently inconveniently wrapped inside a string of stringified JSON.
       *
       * @param  {String} key The element id to get strings for.
       * @return {String}
       */
      _getString: function(key) {
        let str = this.MozLoopService.getStrings(key);
        if (str) {
          str = JSON.parse(str).textContent;
        }
        return str;
      },

      /**
       * Shows an infobar notification at the top of the browser window that warns
       * the user that their browser tabs are being broadcasted through the current
       * conversation.
       */
      _maybeShowBrowserSharingInfoBar: function() {
        this._hideBrowserSharingInfoBar();

        // Don't show the infobar if it's been permanently disabled from the menu.
        if (!this.MozLoopService.getLoopPref(kPrefBrowserSharingInfoBar)) {
          return;
        }

        let box = gBrowser.getNotificationBox();
        let paused = false;
        let bar = box.appendNotification(
          this._getString("infobar_screenshare_browser_message2"),
          kBrowserSharingNotificationId,
          // Icon is defined in browser theme CSS.
          null,
          box.PRIORITY_WARNING_LOW,
          [{
            label: this._getString("infobar_button_pause_label"),
            accessKey: this._getString("infobar_button_pause_accesskey"),
            isDefault: false,
            callback: (event, buttonInfo, buttonNode) => {
              paused = !paused;
              bar.label = paused ? this._getString("infobar_screenshare_paused_browser_message") :
                this._getString("infobar_screenshare_browser_message2");
              bar.classList.toggle("paused", paused);
              buttonNode.label = paused ? this._getString("infobar_button_resume_label") :
                this._getString("infobar_button_pause_label");
              buttonNode.accessKey = paused ? this._getString("infobar_button_resume_accesskey") :
                this._getString("infobar_button_pause_accesskey");
              return true;
            }
          },
          {
            label: this._getString("infobar_button_stop_label"),
            accessKey: this._getString("infobar_button_stop_accesskey"),
            isDefault: true,
            callback: () => {
              this._hideBrowserSharingInfoBar();
              LoopUI.MozLoopService.hangupAllChatWindows();
            }
          }]
        );

        // Keep showing the notification bar until the user explicitly closes it.
        bar.persistence = -1;
      },

      /**
       * Hides the infobar, permanantly if requested.
       *
       * @param {Boolean} permanently Flag that determines if the infobar will never
       *                              been shown again. Defaults to `false`.
       * @return {Boolean} |true| if the infobar was hidden here.
       */
      _hideBrowserSharingInfoBar: function(permanently = false, browser) {
        browser = browser || gBrowser.selectedBrowser;
        let box = gBrowser.getNotificationBox(browser);
        let notification = box.getNotificationWithValue(kBrowserSharingNotificationId);
        let removed = false;
        if (notification) {
          box.removeNotification(notification);
          removed = true;
        }

        if (permanently) {
          this.MozLoopService.setLoopPref(kPrefBrowserSharingInfoBar, false);
        }

        return removed;
      },

      /**
       * Broadcast 'BrowserSwitch' event.
      */
      _notifyBrowserSwitch() {
         // Get the first window Id for the listener.
        this.LoopAPI.broadcastPushMessage("BrowserSwitch",
          gBrowser.selectedBrowser.outerWindowID);
      },

      /**
       * Handles events from gBrowser.
       */
      handleEvent: function(event) {
        switch (event.type) {
          case "DOMTitleChanged":
            // Get the new title of the shared tab
            this._notifyBrowserSwitch();
            break;
          case "TabSelect":
            let wasVisible = false;
            // Hide the infobar from the previous tab.
            if (event.detail.previousTab) {
              wasVisible = this._hideBrowserSharingInfoBar(false, event.detail.previousTab.linkedBrowser);
            }

            // We've changed the tab, so get the new window id.
            this._notifyBrowserSwitch();

            if (wasVisible) {
              // If the infobar was visible before, we should show it again after the
              // switch.
              this._maybeShowBrowserSharingInfoBar();
            }
            break;
          }
      },

      /**
       * Fetch the favicon of the currently selected tab in the format of a data-uri.
       *
       * @param  {Function} callback Function to be invoked with an error object as
       *                             its first argument when an error occurred or
       *                             a string as second argument when the favicon
       *                             has been fetched.
       */
      getFavicon: function(callback) {
        let pageURI = gBrowser.selectedTab.linkedBrowser.currentURI.spec;
        // If the tab page’s url starts with http(s), fetch icon.
        if (!/^https?:/.test(pageURI)) {
          callback();
          return;
        }

        this.PlacesUtils.promiseFaviconLinkUrl(pageURI).then(uri => {
          // We XHR the favicon to get a File object, which we can pass to the FileReader
          // object. The FileReader turns the File object into a data-uri.
          let xhr = xhrClass.createInstance(Ci.nsIXMLHttpRequest);
          xhr.open("get", uri.spec, true);
          xhr.responseType = "blob";
          xhr.overrideMimeType("image/x-icon");
          xhr.onload = () => {
            if (xhr.status != 200) {
              callback(new Error("Invalid status code received for favicon XHR: " + xhr.status));
              return;
            }

            let reader = new FileReader();
            reader.onload = reader.onload = () => callback(null, reader.result);
            reader.onerror = callback;
            reader.readAsDataURL(xhr.response);
          };
          xhr.onerror = callback;
          xhr.send();
        }).catch(err => {
          callback(err || new Error("No favicon found"));
        });
      }
    };

    XPCOMUtils.defineLazyModuleGetter(LoopUI, "hookWindowCloseForPanelClose", "resource://gre/modules/MozSocialAPI.jsm");
    XPCOMUtils.defineLazyModuleGetter(LoopUI, "LoopAPI", "chrome://loop/content/modules/MozLoopAPI.jsm");
    XPCOMUtils.defineLazyModuleGetter(LoopUI, "LoopRooms", "chrome://loop/content/modules/LoopRooms.jsm");
    XPCOMUtils.defineLazyModuleGetter(LoopUI, "MozLoopService", "chrome://loop/content/modules/MozLoopService.jsm");
    XPCOMUtils.defineLazyModuleGetter(LoopUI, "PanelFrame", "resource:///modules/PanelFrame.jsm");
    XPCOMUtils.defineLazyModuleGetter(LoopUI, "PlacesUtils", "resource://gre/modules/PlacesUtils.jsm");

    LoopUI.init();
    window.LoopUI = LoopUI;
  },

  tearDownBrowserUI: function() {
    // Take any steps to remove UI or anything from the browser window
    // document.getElementById() etc. will work here
    // XXX Add in tear-down of the panel.
  },

  // nsIWindowMediatorListener functions.
  onOpenWindow: function(xulWindow) {
    // A new window has opened.
    let domWindow = xulWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                             .getInterface(Ci.nsIDOMWindow);

    // Wait for it to finish loading.
    domWindow.addEventListener("load", function listener() {
      domWindow.removeEventListener("load", listener, false);

      // If this is a browser window then setup its UI.
      if (domWindow.document.documentElement.getAttribute("windowtype") == "navigator:browser") {
        WindowListener.setupBrowserUI(domWindow);
      }
    }, false);
  },

  onCloseWindow: function() {
  },

  onWindowTitleChange: function() {
  }
};

/**
 * Creates the loop button on the toolbar. Due to loop being a system-addon
 * CustomizableUI already has a placement location for the button, so that
 * we can be on the toolbar.
 */
function createLoopButton() {
  CustomizableUI.createWidget({
    id: "loop-button",
    type: "custom",
    label: "loop-call-button3.label",
    tooltiptext: "loop-call-button3.tooltiptext2",
    privateBrowsingTooltiptext: "loop-call-button3-pb.tooltiptext",
    defaultArea: CustomizableUI.AREA_NAVBAR,
    removable: true,
    onBuild: function(aDocument) {
      // If we're not supposed to see the button, return zip.
      if (!Services.prefs.getBoolPref("loop.enabled")) {
        return null;
      }

      let isWindowPrivate = PrivateBrowsingUtils.isWindowPrivate(aDocument.defaultView);

      let node = aDocument.createElementNS(kNSXUL, "toolbarbutton");
      node.setAttribute("id", this.id);
      node.classList.add("toolbarbutton-1");
      node.classList.add("chromeclass-toolbar-additional");
      node.classList.add("badged-button");
      node.setAttribute("label", CustomizableUI.getLocalizedProperty(this, "label"));
      if (isWindowPrivate) {
        node.setAttribute("disabled", "true");
      }
      let tooltiptext = isWindowPrivate ?
        CustomizableUI.getLocalizedProperty(this, "privateBrowsingTooltiptext",
          [CustomizableUI.getLocalizedProperty(this, "label")]) :
        CustomizableUI.getLocalizedProperty(this, "tooltiptext");
      node.setAttribute("tooltiptext", tooltiptext);
      node.setAttribute("removable", "true");
      node.addEventListener("command", function(event) {
        aDocument.defaultView.LoopUI.togglePanel(event);
      });

      return node;
    }
  });
}

/**
 * Loads the default preferences from the prefs file. This loads the preferences
 * into the default branch, so they don't appear as user preferences.
 */
function loadDefaultPrefs() {
  var branch = Services.prefs.getDefaultBranch("");
  Services.scriptloader.loadSubScript("chrome://loop/content/preferences/prefs.js", {
    pref: (key, val) => {
      switch (typeof val) {
        case "boolean":
          branch.setBoolPref(key, val);
          break;
        case "number":
          branch.setIntPref(key, val);
          break;
        case "string":
          branch.setCharPref(key, val);
          break;
      }
    }
  });
}

/**
 * Called when the add-on is started, e.g. when installed or when Firefox starts.
 */
function startup() {
  loadDefaultPrefs();

  createLoopButton();

  // Attach to hidden window (for OS X).
  if (AppConstants.platform == "macosx") {
    try {
      WindowListener.setupBrowserUI(Services.appShell.hiddenDOMWindow);
    } catch (ex) {
      // Hidden window didn't exist, so wait until startup is done.
      let topic = "browser-delayed-startup-finished";
      Services.obs.addObserver(function observer() {
        Services.obs.removeObserver(observer, topic);
        WindowListener.setupBrowserUI(Services.appShell.hiddenDOMWindow);
      }, topic, false);
    }
  }

  // Attach to existing browser windows, for modifying UI.
  let wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
  let windows = wm.getEnumerator("navigator:browser");
  while (windows.hasMoreElements()) {
    let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
    WindowListener.setupBrowserUI(domWindow);
  }

  // Wait for any new browser windows to open.
  wm.addListener(WindowListener);

  // Load our stylesheets.
  let styleSheetService = Cc["@mozilla.org/content/style-sheet-service;1"]
    .getService(Components.interfaces.nsIStyleSheetService);
  let sheets = ["chrome://loop-shared/skin/loop.css"];

  if (AppConstants.platform != "linux") {
    sheets.push("chrome://loop/skin/platform.css");
  }

  for (let sheet of sheets) {
    let styleSheetURI = Services.io.newURI(sheet, null, null);
    styleSheetService.loadAndRegisterSheet(styleSheetURI,
                                           styleSheetService.AUTHOR_SHEET);
  }
}

/**
 * Called when the add-on is shutting down, could be for re-installation
 * or just uninstall.
 */
function shutdown() {
  // Close any open chat windows
  Cu.import("resource:///modules/Chat.jsm");
  let isLoopURL = ({ src }) => /^about:loopconversation#/.test(src);
  [...Chat.chatboxes].filter(isLoopURL).forEach(chatbox => {
    chatbox.content.contentWindow.close();
  });

  // Detach from hidden window (for OS X).
  if (AppConstants.platform == "macosx") {
    WindowListener.tearDownBrowserUI(Services.appShell.hiddenDOMWindow);
  }

  // Detach from browser windows.
  let wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
  let windows = wm.getEnumerator("navigator:browser");
  while (windows.hasMoreElements()) {
    let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
    WindowListener.tearDownBrowserUI(domWindow);
  }

  // Stop waiting for browser windows to open.
  wm.removeListener(WindowListener);

  CustomizableUI.destroyWidget("loop-button");

  // Unload stylesheets.
  let styleSheetService = Cc["@mozilla.org/content/style-sheet-service;1"]
    .getService(Components.interfaces.nsIStyleSheetService);
  let sheets = ["chrome://loop/content/addon/css/loop.css",
                "chrome://loop/skin/platform.css"];
  for (let sheet of sheets) {
    let styleSheetURI = Services.io.newURI(sheet, null, null);
    if (styleSheetService.sheetRegistered(styleSheetURI,
                                          styleSheetService.AUTHOR_SHEET)) {
      styleSheetService.unregisterSheet(styleSheetURI,
                                        styleSheetService.AUTHOR_SHEET);
    }
  }

  // Unload modules.
  Cu.unload("chrome://loop/content/modules/MozLoopAPI.jsm");
  Cu.unload("chrome://loop/content/modules/LoopRooms.jsm");
  Cu.unload("chrome://loop/content/modules/MozLoopService.jsm");
}

function install() {}

function uninstall() {}
