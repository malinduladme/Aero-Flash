package com.smartcamapp;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import java.util.*;

public class WifiBindPackage implements ReactPackage {
    @Override public List<NativeModule> createNativeModules(ReactApplicationContext ctx) {
        return Collections.singletonList(new WifiBindModule(ctx));
    }
    @Override public List<ViewManager> createViewManagers(ReactApplicationContext ctx) {
        return Collections.emptyList();
    }
}
