package com.smartcamapp;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import androidx.annotation.NonNull;
import com.facebook.react.bridge.*;

public class WifiBindModule extends ReactContextBaseJavaModule {
    private ConnectivityManager.NetworkCallback callback;

    WifiBindModule(ReactApplicationContext ctx) { super(ctx); }

    @NonNull @Override public String getName() { return "WifiBind"; }

    /** Pins this process's sockets to the WiFi network, whether or not it has
     *  internet. Without this, Android silently prefers mobile data. */
    @ReactMethod
    public void bindToWifi(final Promise promise) {
        ConnectivityManager cm = (ConnectivityManager)
            getReactApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);

        NetworkRequest req = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();

        callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                cm.bindProcessToNetwork(network);
                promise.resolve(true);
            }
            @Override public void onUnavailable() {
                promise.reject("no_wifi", "no WiFi network available");
            }
        };
        cm.requestNetwork(req, callback);
    }

    @ReactMethod
    public void unbind(Promise promise) {
        ConnectivityManager cm = (ConnectivityManager)
            getReactApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        cm.bindProcessToNetwork(null);
        if (callback != null) { cm.unregisterNetworkCallback(callback); callback = null; }
        promise.resolve(true);
    }
}
