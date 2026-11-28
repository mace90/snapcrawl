import SwiftUI

// A small app for trying snappcrawl: tabs, a list, detail pages, a settings form, a sheet.
// Built with -DVARIANT_B (snappcrawl check --build --set OTHER_SWIFT_FLAGS=-DVARIANT_B) it renames
// a button and adds a row, so two builds differ the way real ones do.

@main
struct DemoApp: App {
    var body: some Scene {
        WindowGroup { RootView() }
    }
}

#if VARIANT_B
let variantB = true
#else
let variantB = false
#endif

struct Workout: Identifiable, Hashable {
    let id: Int
    let name: String
    let minutes: Int
}

let workouts = [
    Workout(id: 1, name: "Ganzkörper", minutes: 30),
    Workout(id: 2, name: "Rücken", minutes: 20),
    Workout(id: 3, name: "Laufen", minutes: 45),
] + (variantB ? [Workout(id: 4, name: "Yoga", minutes: 25)] : [])

struct RootView: View {
    var body: some View {
        TabView {
            NavigationStack { HomeView() }
                .tabItem { Label("Start", systemImage: "house") }
            NavigationStack { WorkoutsView() }
                .tabItem { Label("Workouts", systemImage: "figure.run") }
            NavigationStack { SettingsView() }
                .tabItem { Label("Einstellungen", systemImage: "gear") }
        }
    }
}

struct HomeView: View {
    @State private var showTip = false
    var body: some View {
        List {
            Section("Heute") {
                NavigationLink(variantB ? "Mein Profil" : "Profil") { ProfileView() }
                NavigationLink("Statistik") { StatsView() }
                Button("Tipp des Tages") { showTip = true }
            }
        }
        .navigationTitle("Hallo, Lena")
        .sheet(isPresented: $showTip) {
            NavigationStack {
                Text("Trink genug Wasser.").padding()
                    .navigationTitle("Tipp")
                    .toolbar { Button("Fertig") { showTip = false } }
            }
        }
    }
}

struct WorkoutsView: View {
    var body: some View {
        List(workouts) { w in
            NavigationLink(w.name) { WorkoutDetail(workout: w) }
        }
        .navigationTitle("Workouts")
    }
}

struct WorkoutDetail: View {
    let workout: Workout
    var body: some View {
        VStack(spacing: 16) {
            Text("\(workout.minutes) Minuten").font(.title2)
            NavigationLink("Starten") { Text("Los geht's").font(.largeTitle).navigationTitle("Player") }
                .buttonStyle(.borderedProminent)
        }
        .navigationTitle(workout.name)
    }
}

struct ProfileView: View {
    var body: some View {
        Form {
            LabeledContent("Name", value: "Lena")
            LabeledContent("Ziel", value: "3× pro Woche")
            NavigationLink("Bearbeiten") { Text("Profil bearbeiten").navigationTitle("Bearbeiten") }
        }
        .navigationTitle("Profil")
    }
}

struct StatsView: View {
    var body: some View {
        List {
            LabeledContent("Workouts", value: "12")
            LabeledContent("Minuten", value: "340")
        }
        .navigationTitle("Statistik")
    }
}

struct SettingsView: View {
    @State private var reminders = true
    var body: some View {
        Form {
            Toggle("Erinnerungen", isOn: $reminders)
            NavigationLink("Datenschutz") { Text("Deine Daten bleiben auf dem Gerät.").padding().navigationTitle("Datenschutz") }
            NavigationLink("Über") { Text("Demo 1.0").navigationTitle("Über") }
        }
        .navigationTitle("Einstellungen")
    }
}
